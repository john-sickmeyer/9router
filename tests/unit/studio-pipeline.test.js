import { beforeEach, describe, it, expect, vi } from "vitest";
const fx = vi.hoisted(() => ({ accounts: [], sent: [], events: [], failFirst: false, reportedTier: null, usage: null }));
vi.mock("../../open-sse/services/usage/claude.js", () => ({ getClaudeUsage: async () => fx.usage }));
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
    const isClaude = args.model.startsWith("claude-");
    const body = isClaude ? args.body : new CodexExecutor().transformRequest(args.model, args.body, true, args.credentials);
    assertOutboundControls(body, args.credentials.studioControls);
    fx.sent.push({ account: args.credentials.connectionId, body: structuredClone(body) });
    if (fx.failFirst && fx.sent.length === 1) return { transformedBody: body, response: Response.json({ error: { message: "Rate limit reached" } }, { status: 429 }) };
    if (isClaude) return { transformedBody: body, response: Response.json({ id: "test", type: "message", role: "assistant", model: args.model,
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) };
    const payload = { type: "response.completed", response: { id: "test", status: "completed", service_tier: fx.reportedTier || body.service_tier, reasoning: body.reasoning, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 1, output_tokens: 1 } } };
    return { transformedBody: body, response: new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } }) };
  } }) };
});
const { handleChat } = await import("../../src/sse/handlers/chat.js");
beforeEach(() => {
  fx.sent = []; fx.events = []; fx.failFirst = false; fx.reportedTier = null; fx.usage = null;
  fx.accounts = ["one", "two"].map(id => ({ id, provider: "codex", isActive: true, accessToken: "fixture", providerSpecificData: { studioCapabilities: { checkedAt: new Date().toISOString(), models: { "gpt-6-astra": { tiers: ["ultrafast"], efforts: ["max", "ultra"] } } } } }));
});
describe("Studio client-to-provider pipeline", () => {
  it("rotates Claude after weekly exhaustion and skips it on subsequent requests", async () => {
    fx.accounts = ["one", "two"].map(id => ({ id, provider: "claude", isActive: true, accessToken: "fixture" }));
    fx.usage = { quotas: { "weekly (7d)": { remainingPercentage: 0, resetAt: "2099-01-01T00:00:00.000Z" } } };
    fx.failFirst = true;
    const send = () => handleChat(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cc/claude-opus-5-5", stream: false, max_tokens: 8, messages: [{ role: "user", content: "hi" }], output_config: { effort: "high" } }) }));
    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("OK");
    expect(fx.accounts[0].modelLock___all).toBe("2099-01-01T00:00:00.000Z");
    expect((await send()).status).toBe(200);
    expect(fx.sent.map(row => row.account)).toEqual(["one", "two", "two"]);
    for (const { body } of fx.sent) expect(body.output_config.effort).toBe("high");
  });
  it.each(["gpt-6.1-sol", "gpt-6-astra"].flatMap(model => ["standard", "fast", "ultrafast"].flatMap(speed => ["low", "high"].map(effort => ({ model, speed, effort })))))
  ("routes the native picker alias $model@$speed with independent $effort effort", async ({ model, speed, effort }) => {
    for (const account of fx.accounts) {
      account.providerSpecificData.studioCapabilities.models[model] = { tiers: ["priority", "ultrafast"], efforts: ["low", "high", "max"] };
    }
    fx.failFirst = true;
    const response = await handleChat(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-cli/0.162.1" },
      body: JSON.stringify({ model: `${model}@${speed}`, reasoning: { effort }, input: "Preserve this conversation", stream: false }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OK");
    expect(fx.sent.map(s => s.account)).toEqual(["one", "two"]);
    for (const { body } of fx.sent) {
      expect(body.model).toBe(model);
      expect(body.service_tier || "default").toBe({ standard: "default", fast: "priority", ultrafast: "ultrafast" }[speed]);
      expect(body.reasoning.effort).toBe(effort);
      expect(JSON.stringify(body.input)).toContain("Preserve this conversation");
    }
  });

  it("preserves useful output while clearly auditing ambiguous Codex default metadata", async () => {
    fx.reportedTier = "default";
    const response = await handleChat(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-cli/0.163.0" },
      body: JSON.stringify({ model: "cx/gpt-6-astra@ultrafast(max)", input: "hi", stream: false }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OK");
    expect(fx.events).toContainEqual(expect.objectContaining({ state: "completed", speedVerified: false, warning: expect.stringContaining("did not confirm") }));
    expect(fx.sent).toHaveLength(1);
  });
  it("surfaces a provider downgrade as failure through the full JSON handler", async () => {
    fx.reportedTier = "priority";
    const response = await handleChat(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/gpt-6-astra@ultrafast(max)", input: "hi", stream: false }),
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fx.events.some(e => e.state === "completed")).toBe(false);
  });

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
