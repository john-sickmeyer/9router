import { isOpenaiPoolEnabled, OPENAI_METADATA_REVIEWED_AT, OPENAI_METADATA_TTL_MS } from "open-sse/config/openaiPlatform.js";

export function openaiPoolWarnings(connections, now = Date.now()) {
  if (!isOpenaiPoolEnabled()) return [];
  const warnings = [];
  const blocked = connections.filter(c => c.provider === "openai" && c.isActive && c.studioBillingState?.status === "blocked").length;
  if (blocked) warnings.push(`${blocked} OpenAI API account(s) suspended by billing limits. Eligible OAuth accounts remain available; restore credits or limits, then retry API in Studio controls.`);
  if (now - Date.parse(OPENAI_METADATA_REVIEWED_AT) > OPENAI_METADATA_TTL_MS) {
    warnings.push(`OpenAI model and speed metadata needs review (last reviewed ${OPENAI_METADATA_REVIEWED_AT}).`);
  }
  return warnings;
}
