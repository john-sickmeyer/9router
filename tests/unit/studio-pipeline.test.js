import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as transport from "../../open-sse/utils/proxyFetch.js";
import { CODEX_TURN_STATE_HEADER } from "../../open-sse/config/studioControls.js";
const fx = vi.hoisted(() => ({ accounts: [], sent: [], events: [], failFirst: false, reportedTier: null, usage: null, realCodex: false }));
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
vi.mock("@/lib/studio/capabilities", () => ({ refreshOpenaiControlCapabilities: async () => { throw new Error("Codex must not refresh account capabilities"); } }));
vi.mock("@/lib/studio/audit.js", () => ({ isControlDraining: () => false, recordControl: async e => fx.events.push(e) }));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null, enforceKeyAccess: async () => null, filterAdapterModels: async (_ctx, models) => models }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {} }) }));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
  const { assertOutboundControls } = await import("../../open-sse/services/studioControls.js");
  return { getExecutor: () => fx.realCodex ? new CodexExecutor() : ({ noAuth: true, async execute(args) {
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
  fx.realCodex = false;
  fx.accounts = ["one", "two"].map(id => ({ id, provider: "codex", isActive: true, accessToken: "fixture" }));
});

describe("Codex turn-state through the Studio Responses route", () => {
  const model = "cx/gpt-6.2-sol@ultrafast";
  const markerA = "opaque.A+/==";
  const markerB = "opaque.B+/==";
  let replies, sent, session;

  beforeEach(() => {
    fx.realCodex = true;
    for (const account of fx.accounts) account.providerSpecificData = { workspaceId: account.id };
    session = crypto.randomUUID();
    replies = [];
    sent = [];
    vi.spyOn(transport, "proxyAwareFetch").mockImplementation(async (_url, init) => {
      const headers = new Headers(init.headers);
      sent.push({ account: headers.get("chatgpt-account-id"), state: headers.get(CODEX_TURN_STATE_HEADER), hint: headers.get("x-codex-routing-hint") });
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected provider call");
      const responseHeaders = new Headers({ "content-type": "text/event-stream" });
      if (reply.state) responseHeaders.set(CODEX_TURN_STATE_HEADER, reply.state);
      if (reply.status) return Response.json({ error: { message: "Rate limit reached" } }, { status: reply.status, headers: responseHeaders });
      const completed = { type: "response.completed", response: { id: "resp_test", model: "gpt-6.2-sol",
        status: "completed", service_tier: "ultrafast", output: [{ type: "message", role: "assistant",
          content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 1, output_tokens: 1 } } };
      return new Response("data: " + JSON.stringify(completed) + "\n\n", { headers: responseHeaders });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function call({ state, stream = true, thread = session, key = "client-one", turn = "turn-one", path = "responses" } = {}) {
    const headers = new Headers({ "content-type": "application/json", session_id: thread,
      authorization: "Bearer " + key, "x-codex-turn-metadata": JSON.stringify({ turn_id: turn }) });
    if (state) headers.set(CODEX_TURN_STATE_HEADER, state);
    const input = path === "responses" ? { input: "Return OK" } : { messages: [{ role: "user", content: "Return OK" }] };
    const response = await handleChat(new Request("http://localhost/v1/" + path, {
      method: "POST", headers, body: JSON.stringify({ model, stream, ...input }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    if (response.headers.has(CODEX_TURN_STATE_HEADER)) {
      expect(response.headers.get("access-control-expose-headers")).toContain(CODEX_TURN_STATE_HEADER);
    }
    return response.headers.get(CODEX_TURN_STATE_HEADER);
  }

  it.each([true, false])("passes an issued marker unchanged and prefers its eligible owner (stream=%s)", async stream => {
    replies.push({ state: markerA }, {}, {});
    expect(await call({ stream })).toBe(markerA);
    fx.accounts.reverse();
    expect(await call({ state: markerA, stream })).toBeNull();
    await call({ stream });
    expect(sent.map(r => [r.account, r.state])).toEqual([["one", null], ["one", markerA], ["two", null]]);
    expect(sent.every(r => r.hint === "model=gpt-6.2-sol;tier=ultrafast")).toBe(true);
    expect(fx.events).toContainEqual(expect.objectContaining({ state: "outbound", sentTurnState: true, receivedTurnState: false }));
  });

  it("rotates an unavailable owner without replaying its marker, including clients that keep echoing the first value", async () => {
    replies.push({ state: markerA }, { status: 429, state: "error-marker" }, { state: markerB }, {}, {});
    await call();
    expect(await call({ state: markerA })).toBe(markerB);
    await call({ state: markerA });
    await call({ state: markerB });
    expect(sent.map(r => [r.account, r.state])).toEqual([
      ["one", null], ["one", markerA], ["two", null], ["two", markerB], ["two", markerB],
    ]);
  });

  it("echoes a marker received before a same-account transport retry", async () => {
    replies.push({ status: 503, state: markerA }, {});
    expect(await call()).toBe(markerA);
    expect(sent.map(r => [r.account, r.state])).toEqual([["one", null], ["one", markerA]]);
  }, 20000);

  it("isolates fresh turns, different clients or sessions, changed OAuth workspaces and translated routes", async () => {
    replies.push({ state: markerA }, {}, {}, {}, {}, {}, { state: "translated-marker" });
    await call();
    await call({ state: "never-issued" });
    await call({ state: markerA, thread: "another-session" });
    await call({ state: markerA, key: "another-client" });
    await call({ state: markerA, turn: "next-turn" });
    fx.accounts[0].providerSpecificData.workspaceId = "reauthenticated-workspace";
    await call({ state: markerA });
    expect(await call({ state: markerA, path: "chat/completions" })).toBeNull();
    expect(sent.map(r => r.state)).toEqual(Array(7).fill(null));
  });
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
  it.each(["gpt-6.1-sol", "gpt-6-astra", "gpt-6.2-sol", "gpt-6.2-astra"].flatMap(model => ["standard", "fast", "ultrafast"].flatMap(speed => ["low", "high"].map(effort => ({ model, speed, effort })))))
  ("routes the native picker alias $model@$speed with independent $effort effort", async ({ model, speed, effort }) => {
    fx.accounts[0].providerSpecificData = { studioCapabilities: { checkedAt: "2000-01-01T00:00:00Z",
      models: { [model]: { tiers: ["priority"], efforts: [] } } } };
    fx.failFirst = true;
    const response = await handleChat(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-cli/0.169.0" },
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
      method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-cli/0.169.0" },
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
    const response = await handleChat(new Request(`http://localhost/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": endpoint === "responses" ? "codex-cli/0.169.0" : "test-client" }, body: JSON.stringify(body) }));
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
