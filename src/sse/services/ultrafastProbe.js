import { randomInt, randomUUID } from "node:crypto";
import { getSettings } from "@/lib/localDb";
import { getProviderCredentials } from "./auth.js";
import { checkAndRefreshToken, updateProviderCredentials } from "./tokenRefresh.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { ULTRAFAST_PING, speedOwner } from "open-sse/services/ultrafastPolicy.js";
import { refreshOpenaiControlCapabilities } from "@/lib/studio/capabilities.js";
import * as log from "../utils/logger.js";
import { observeQuotaHeaders } from "@/lib/studio/codexQuotaReserve.js";

const insufficient = (reason, retryMs = 60_000) => ({ classification:"insufficient", tps:null, reason, retryMs });

export async function enrollUltrafastAccounts(provider) {
  const { model, tier, effort } = ULTRAFAST_PING;
  if (provider === "openai") await refreshOpenaiControlCapabilities();
  await getProviderCredentials(provider, null, model, { ultrafastEnrollOnly:true,
    requestControls:{ provider, model, tier, effort } });
}

export async function runUltrafastProbe(row, requestId, yieldToTraffic) {
  const { provider, connectionId } = row;
  const { model, tier, effort } = ULTRAFAST_PING;
  const requestControls = { provider, model, tier, effort };
  if (provider === "openai") await refreshOpenaiControlCapabilities({ connectionId, monitorOwner: row.owner });
  const exact = await getProviderCredentials(provider, null, model, { requestControls,
    ultrafastProbeConnectionId:connectionId, ultrafastProbeOwner:row.owner });
  if (exact?.quotaReserveUnavailable) return insufficient("quota-unavailable-for-ping", 5 * 60_000);
  if (exact?.connectionId !== connectionId || speedOwner(exact._connection) !== row.owner) {
    return insufficient("account-ineligible", 5 * 60_000);
  }
  const credentials = await checkAndRefreshToken(provider, exact);
  const start = randomInt(100, 600);
  const length = 384;
  const expectedText = Array.from({ length }, (_,i) => String(start+i)).join(" ");
  const question = `Output every integer from ${start} through ${start+length-1} inclusive, in order, separated by a single space. Return only the numbers. Do not use tools.`;
  const session = randomUUID();
  const body = { model, input:[{ role:"user", content:[{ type:"input_text", text:question }] }],
    store:false, stream:true, reasoning:{ effort }, service_tier:tier, prompt_cache_key:session };
  const settings = await getSettings();
  yieldToTraffic?.throwIfAborted();
  let delivery, sentTier, sentEffort, reportedTier;
  const result = await handleChatCore({
    body, modelInfo:{ provider, model }, credentials, connectionId, requestControls, log,
    clientRawRequest:{ path:"/v1/responses", headers:{ session_id:session }, body },
    userAgent:"9router-studio-ultrafast-probe", sourceFormatOverride:FORMATS.OPENAI_RESPONSES,
    providerOverrides:(settings.providerOverrides || {})[provider] || null,
    clientSignal:yieldToTraffic ? AbortSignal.any([yieldToTraffic,AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
    ultrafastSample:{ expectedText },
    onProviderHeaders:provider === "codex" ? headers => observeQuotaHeaders(exact._connection, model, headers) : undefined,
    onCredentialsRefreshed: fresh => updateProviderCredentials(connectionId, {
      ...fresh, existingProviderSpecificData: exact.providerSpecificData, testStatus:"active" }),
    onControlEvent: event => {
      if (event.state === "outbound") { sentTier=event.sentTier; sentEffort=event.sentEffort; }
      if (event.state === "completed") { delivery=event.delivery; reportedTier=event.reportedTier; }
    },
  });
  if (!result.success) {
    const retryHeader = result.response?.headers?.get("retry-after");
    const retryMs = /^\d+$/.test(retryHeader || "") ? Number(retryHeader)*1000 : Date.parse(retryHeader || "")-Date.now();
    const minimum = [401,402,403,429].includes(result.status) ? 5*60_000 : 60_000;
    return insufficient(`http-${result.status || "error"}`, Math.max(minimum,
      Number.isFinite(retryMs) ? retryMs : 0, Number(result.resetsAtMs || 0)-Date.now()));
  }
  const reader = result.response.body.getReader();
  try {
    while (!(await reader.read()).done) { /* drain immediately to measure the provider connection */ }
  } catch { return insufficient("incomplete-stream"); }
  if (sentTier !== tier || sentEffort !== effort) return insufficient("wire-controls-mismatch");
  if (!delivery || delivery.reportedModel !== model) return insufficient("model-or-completion-mismatch");
  return { ...delivery, sentTier, sentEffort, reportedTier, requestId };
}
