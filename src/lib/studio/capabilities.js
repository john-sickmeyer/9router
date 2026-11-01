import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { CAPABILITY_TTL_MS } from "open-sse/config/studioControls.js";
import { OPENAI_MODELS_URL } from "open-sse/config/openaiPlatform.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const key = Symbol.for("9router.studio.capabilities");
const inFlight = globalThis[key] ||= new Map();

export async function refreshOpenaiControlCapabilities({ force = false } = {}) {
  const connections = await getProviderConnections({ provider: "openai", isActive: true });
  const results = [];
  for (const connection of connections) {
    const stamp = Date.parse(connection.providerSpecificData?.studioCapabilities?.checkedAt);
    if (!force && Number.isFinite(stamp) && Date.now() - stamp < CAPABILITY_TTL_MS) continue;
    const key = `openai:${connection.id}`;
    if (!inFlight.has(key)) inFlight.set(key, (async () => {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const response = await proxyAwareFetch(OPENAI_MODELS_URL, {
        headers: { Authorization: `Bearer ${connection.apiKey}` }, signal: AbortSignal.timeout(15000), redirect: "error",
      }, proxy);
      if (!response.ok) throw new Error(`OpenAI catalog returned HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.data) || !payload.data.length) throw new Error("Empty OpenAI model catalog");
      const models = Object.fromEntries(payload.data.filter(m => typeof m.id === "string").map(m => [m.id, {
        efforts: getThinkingLevels("openai", m.id) || [],
      }]));
      // /models confirms visibility, not tier entitlement or available credit.
      const studioCapabilities = { checkedAt: new Date().toISOString(), plan: "API", models };
      const fresh = (await getProviderConnections({ provider: "openai" })).find(c => c.id === connection.id);
      await updateProviderConnection(connection.id, { providerSpecificData: { ...fresh?.providerSpecificData, studioCapabilities } });
      return studioCapabilities;
    })().finally(() => inFlight.delete(key)));
    try { results.push({ id: connection.id, ok: true, capabilities: await inFlight.get(key) }); }
    catch { results.push({ id: connection.id, ok: false, error: "Could not refresh OpenAI model availability" }); }
  }
  return results;
}
