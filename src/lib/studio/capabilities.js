import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh";
import { CAPABILITY_TTL_MS, CODEX_CATALOG_URL, CODEX_USAGE_URL, CODEX_CATALOG_VERSION } from "open-sse/config/studioControls.js";

const key = Symbol.for("9router.studio.capabilities");
const inFlight = globalThis[key] ||= new Map();

async function refresh(connection) {
  const credentials = await checkAndRefreshToken("codex", { ...connection, connectionId: connection.id });
  const headers = { Authorization: `Bearer ${credentials.accessToken}`, "Chatgpt-Account-Id": credentials.providerSpecificData?.chatgptAccountId || "", "User-Agent": `codex_cli_rs/${CODEX_CATALOG_VERSION}` };
  const responses = await Promise.all([CODEX_CATALOG_URL, CODEX_USAGE_URL].map(url => fetch(url, { headers, signal: AbortSignal.timeout(15000) })));
  if (responses.some(r => !r.ok)) throw new Error(`Capability refresh returned ${responses.map(r => r.status).join("/")}`);
  const [catalog, usage] = await Promise.all(responses.map(r => r.json()));
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error("Empty Codex model catalog");
  const models = Object.fromEntries(catalog.models.map(m => [m.slug, {
    tiers: (m.service_tiers || []).map(t => typeof t === "string" ? t : t.id || t.value).filter(Boolean),
    efforts: (m.supported_reasoning_levels || []).map(e => typeof e === "string" ? e : e.effort).filter(Boolean),
  }]));
  const studioCapabilities = { checkedAt: new Date().toISOString(), plan: usage.plan_type, models };
  // Merge against the current row: token refresh or another request may have updated it.
  const fresh = (await getProviderConnections({ provider: "codex" })).find(c => c.id === connection.id);
  await updateProviderConnection(connection.id, { providerSpecificData: { ...fresh?.providerSpecificData, studioCapabilities } });
  return studioCapabilities;
}

export async function refreshControlCapabilities({ force = false } = {}) {
  const connections = await getProviderConnections({ provider: "codex", isActive: true });
  const results = [];
  // Limit concurrent provider lookups; share refreshes between simultaneous requests.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, connections.length) }, async () => {
    while (next < connections.length) {
      const c = connections[next++];
      const stamp = Date.parse(c.providerSpecificData?.studioCapabilities?.checkedAt);
      if (!force && Number.isFinite(stamp) && Date.now() - stamp < CAPABILITY_TTL_MS) continue;
      if (!inFlight.has(c.id)) inFlight.set(c.id, refresh(c).finally(() => inFlight.delete(c.id)));
      try { results.push({ id: c.id, ok: true, capabilities: await inFlight.get(c.id) }); }
      catch (error) { results.push({ id: c.id, ok: false, error: error.message }); }
    }
  }));
  return results;
}
