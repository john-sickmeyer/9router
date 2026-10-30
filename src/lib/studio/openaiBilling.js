import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { OPENAI_BILLING_PROBE_MS } from "open-sse/config/openaiPlatform.js";
const probes = globalThis[Symbol.for("9router.studio.billingProbes")] ||= new Set();

export function billingUnavailable(connection, now = Date.now()) {
  const state = connection.studioBillingState;
  return connection.provider === "openai" && (state?.status === "blocked"
    || (state?.status === "retry" && (probes.has(connection.id) || Date.parse(state.probeUntil) > now)));
}

// Called inside the credential selector mutex. Only one request probes a reopened key.
export async function claimBillingRetry(connection) {
  if (connection.provider !== "openai" || connection.studioBillingState?.status !== "retry") return;
  const state = { ...connection.studioBillingState, probeUntil: new Date(Date.now() + OPENAI_BILLING_PROBE_MS).toISOString() };
  await updateProviderConnection(connection.id, { studioBillingState: state });
  probes.add(connection.id);
  connection.studioBillingState = state;
}

export function releaseBillingRetry(id) { probes.delete(id); }

export async function blockOpenaiBilling(id, code) {
  await updateProviderConnection(id, {
    studioBillingState: { status: "blocked", code: code || "insufficient_quota", blockedAt: new Date().toISOString() },
    testStatus: "unavailable", errorCode: 429,
    lastError: "OpenAI billing capacity unavailable. After adding credits or fixing the spend limit, retry the API account in Studio controls.",
    lastErrorAt: new Date().toISOString(),
  });
}

export async function reopenOpenaiBilling(id) {
  const connection = await getProviderConnectionById(id);
  if (!connection || connection.provider !== "openai") throw new Error("OpenAI connection not found");
  if (connection.studioBillingState?.status !== "blocked") return;
  await updateProviderConnection(id, {
    studioBillingState: { ...connection.studioBillingState, status: "retry", probeUntil: null },
  });
}
