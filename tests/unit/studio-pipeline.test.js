import { beforeEach, describe, it, expect, vi } from "vitest";
const fx = vi.hoisted(() => ({ accounts: [], sent: [], events: [], failFirst: false }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, providerThinking: { codex: { mode: "low" } } }),
  getProviderConnections: async () => fx.accounts,
  getProviderConnectionById: async id => fx.accounts.find(c => c.id === id),
  updateProviderConnection: async (id, fields) => Object.assign(fx.accounts.find(c => c.id === id), fields),
  getModelAliases: async () => ({}), getComboByName: async () => null,
  getProviderNodes: async () => [], getCustomModels: async () => [], getCombos: async () => [],
  getProxyPools: async () => [], validateApiKey: async () => true,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn() }));
vi.mock("@/lib/studio/capabilities", () => ({ refreshControlCapabilities: async () => [] }));
vi.mock("@/lib/studio/audit.js", () => ({ isControlDraining: () => false, recordControl: async e => fx.events.push(e) }));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null, enforceKeyAccess: async () => null, filterAdapterModels: async (_ctx, models) => models }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {} }) }));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
  const { assertOutboundControls } = await import("../../open-sse/services/studioControls.js");
  return { getExecutor: () => ({ noAuth: true, async execute(args) {
    const body = new CodexExecutor().transformRequest(args.model, args.body, true, args.credentials);
    assertOutboundControls(body, args.credentials.studioControls);
    fx.sent.push({ account: args.credentials.connectionId, body: structuredClone(body) });
    if (fx.failFirst && fx.sent.length === 1) return { transformedBody: body, response: Response.json({ error: { message: "Rate limit reached" } }, { status: 429 }) };
    const payload = { type: "response.completed", response: { id: "test", status: "completed", service_tier: body.service_tier, reasoning: body.reasoning, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 1, output_tokens: 1 } } };
    return { transformedBody: body, response: new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } }) };
  } }) };
});
const { handleChat } = await import("../../src/sse/handlers/chat.js");
beforeEach(() => {
  fx.sent = []; fx.events = []; fx.failFirst = false;
  fx.accounts = ["one", "two"].map(id => ({ id, provider: "codex", isActive: true, accessToken: "fixture", providerSpecificData: { studioCapabilities: { checkedAt: new Date().toISOString(), models: { "gpt-6-astra": { tiers: ["ultrafast"], efforts: ["max", "ultra"] } } } } }));
});
describe("Studio client-to-provider pipeline", () => {
  it.each(["responses", "chat/completions"])("preserves controls and conversation through a 429 on /%s", async endpoint => {
    fx.failFirst = true;
    const body = { model: "cx/gpt-6-astra@ultrafast(max)", stream: false,
      ...(endpoint === "responses" ? { input: [{ role: "user", content: "Unique conversation context" }] } : { messages: [{ role: "user", content: "Unique conversation context" }] }) };
    const response = await handleChat(new Request(`http://localhost/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": endpoint === "responses" ? "codex-cli/0.163.0" : "test-client" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    await response.text();
    expect(fx.sent.map(s => s.account)).toEqual(["one", "two"]);
    for (const { body: sent } of fx.sent) {
      expect(sent.service_tier).toBe("ultrafast"); expect(sent.reasoning.effort).toBe("max");
      expect(JSON.stringify(sent.input)).toContain("Unique conversation context");
    }
    expect(fx.events.some(e => e.state === "completed" && e.speedVerified)).toBe(true);
  });
});
