import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fx = vi.hoisted(() => ({ accounts: [], sent: [], events: [], replies: [], aliases: {}, allow: null }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getProviderConnections: async (filter = {}) => structuredClone(fx.accounts.filter(c =>
    (!filter.provider || c.provider === filter.provider) && (filter.isActive === undefined || c.isActive === filter.isActive))),
  getProviderConnectionById: async id => structuredClone(fx.accounts.find(c => c.id === id)),
  updateProviderConnection: async (id, fields) => structuredClone(Object.assign(fx.accounts.find(c => c.id === id), fields)),
  getModelAliases: async () => fx.aliases, getComboByName: async () => null,
  getProviderNodes: async () => [], getCustomModels: async () => [], getCombos: async () => [],
  getProxyPools: async () => [], validateApiKey: async () => true,
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => fx.allow ? { id: "fixture", access: { restricted: true, allow: fx.allow } } : {} }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn() }));
vi.mock("@/lib/studio/capabilities", () => ({ refreshControlCapabilities: async () => [], refreshOpenaiControlCapabilities: async () => [] }));
vi.mock("@/lib/studio/audit.js", () => ({ isControlDraining: () => false, recordControl: async e => fx.events.push(e) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {} }) }));
vi.mock("../../open-sse/utils/proxyFetch.js", async original => ({ ...await original(), proxyAwareFetch: (...args) => global.fetch(...args) }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { reopenOpenaiBilling, releaseBillingRetry } = await import("../../src/lib/studio/openaiBilling.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { preflightOpenaiStream, classifyOpenaiFailure } = await import("../../open-sse/services/openaiPlatform.js");
const { observeControlResponse } = await import("../../open-sse/services/controlResponse.js");
const { studioModelCatalog } = await import("../../open-sse/services/studioCatalog.js");
const { OPENAI_POOL_MODELS, OPENAI_CURRENT_EFFORTS } = await import("../../open-sse/config/openaiPlatform.js");
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const failure = (code, status = 429, type = "insufficient_quota", headers = {}) =>
  Response.json({ error: { code, type, message: "Synthetic provider failure" } }, { status, headers });
const complete = body => ({ type: "response.completed", response: { id: "fixture", object: "response", status: "completed",
  service_tier: body.service_tier || "default", reasoning: body.reasoning, model: body.model,
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
  usage: { input_tokens: 1, output_tokens: 1 } } });
function account(id, provider = "openai") {
  return { id, provider, isActive: true, apiKey: provider === "openai" ? id : undefined, accessToken: id,
    authType: provider === "openai" ? "apikey" : "oauth", providerSpecificData: { studioCapabilities: {
      checkedAt: new Date().toISOString(), models: Object.fromEntries(OPENAI_POOL_MODELS.map(m => [m, {
        tiers: ["priority", "ultrafast"], efforts: OPENAI_CURRENT_EFFORTS,
      }])),
    } } };
}
async function send(body = {}, model = "gpt-6.1-sol@standard") {
  return handleChat(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json", "user-agent": "codex-cli/0.163.0", authorization: "Bearer fixture" },
    body: JSON.stringify({ model, input: "Synthetic check", stream: false, reasoning: { effort: "max" }, ...body }),
  }));
}
beforeEach(() => {
  vi.stubEnv("STUDIO_OPENAI_POOL_ENABLED", "1");
  fx.accounts = [account("api"), account("oauth", "codex")];
  fx.sent = []; fx.events = []; fx.replies = []; fx.aliases = {}; fx.allow = null;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const body = JSON.parse(options.body);
    fx.sent.push({ url: String(url), body, account: options.headers.Authorization?.replace("Bearer ", "") });
    const reply = fx.replies.shift();
    if (reply) return typeof reply === "function" ? reply(body) : reply;
    return body.stream || String(url).includes("chatgpt.com") ? sse(frame(complete(body))) : Response.json(complete(body).response);
  }));
});
afterEach(() => { for (const a of fx.accounts) releaseBillingRetry(a.id); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("OpenAI-first real request pipeline", () => {
  it.each(OPENAI_POOL_MODELS.flatMap(model => ["standard", "fast", "ultrafast"].map(speed => ({ model, speed }))))
  ("uses API Responses for $model@$speed and preserves max", async ({ model, speed }) => {
    const response = await send({}, `${model}@${speed}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OK");
    expect(response.headers.get("x-9router-serving-provider")).toBe("openai");
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0].url).toBe("https://api.openai.com/v1/responses");
    expect(fx.sent[0].body).toMatchObject({ model, store: false, reasoning: { effort: "max" },
      service_tier: { standard: "default", fast: "priority", ultrafast: "ultrafast" }[speed] });
  });

  it.each(["credit_balance_exhausted", "insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"])
  ("persists %s, preserves the controls, and skips the depleted key on the next turn", async code => {
    fx.replies.push(failure(code));
    const first = await send({}, "gpt-6-astra@ultrafast");
    expect(first.status).toBe(200); await first.text();
    expect(first.headers.get("x-9router-fallback-reason")).toBe("api-billing");
    expect(fx.accounts[0].studioBillingState).toMatchObject({ status: "blocked", code });
    const second = await send({}, "gpt-6-astra@ultrafast"); await second.text();
    expect(fx.sent.map(s => s.account)).toEqual(["api", "oauth", "oauth"]);
    for (const { body } of fx.sent) expect(body).toMatchObject({ model: "gpt-6-astra", service_tier: "ultrafast", reasoning: { effort: "max" } });
    const ids = fx.events.slice(0, fx.events.findIndex((e, i) => i > 0 && e.requestId !== fx.events[0].requestId)).map(e => e.requestId);
    expect(new Set(ids).size).toBe(1);
  });

  it("tries the next API key before OAuth", async () => {
    fx.accounts.splice(1, 0, account("api2")); fx.replies.push(failure("credit_balance_exhausted"));
    expect((await send()).status).toBe(200);
    expect(fx.sent.map(s => s.account)).toEqual(["api", "api2"]);
  });

  it("honors Retry-After without treating an ordinary 429 as exhausted credit", async () => {
    fx.replies.push(failure("slow_down", 429, "insufficient_quota", { "retry-after": "3600" }));
    const now = Date.now(); expect((await send()).status).toBe(200);
    expect(fx.accounts[0].studioBillingState).toBeUndefined();
    expect(Date.parse(fx.accounts[0]["modelLock_gpt-6.1-sol"])).toBeGreaterThanOrEqual(now + 3600000);
    await send(); expect(fx.sent.map(s => s.account)).toEqual(["api", "oauth", "oauth"]);
  });

  it("does not retry malformed requests or conflicting controls", async () => {
    fx.replies.push(failure("invalid_value", 400, "invalid_request_error"));
    expect((await send()).status).toBe(400); expect(fx.sent).toHaveLength(1);
    expect((await send({ service_tier: "ultrafast" })).status).toBe(400);
    expect((await send({ reasoning: { effort: "ultra" } })).status).toBe(400);
    expect(fx.sent).toHaveLength(1);
  });

  it("preserves Lite declarations, namespaces, custom tools, images, phase and opaque reasoning", async () => {
    const tools = [{ type: "namespace", name: "tools", description: "Fixture", tools: [
      { type: "function", name: "echo", parameters: { type: "object", properties: {} } },
    ] }, { type: "custom", name: "apply_patch", format: { type: "text" } }];
    const history = [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,fixture" }, { type: "input_text", text: "hi" }] },
      { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque-fixture" },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Working" }] },
      { type: "function_call", call_id: "c1", name: "tools.echo", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "Result" },
    ];
    expect((await send({ input: [{ type: "additional_tools", tools }, ...history], instructions: "Keep all context" })).status).toBe(200);
    expect(fx.sent[0].body.input).toEqual(history); expect(fx.sent[0].body.tools).toEqual(tools);
    expect(fx.sent[0].body.instructions).toBe("Keep all context");
  });

  it("uses OAuth for in-conversation Lite tool changes and rejects account-scoped references", async () => {
    expect((await send({ input: [{ role: "user", content: "hi" }, { type: "additional_tools", tools: [] }] })).status).toBe(200);
    expect(fx.sent[0].account).toBe("oauth");
    expect((await send({ previous_response_id: "resp_1" })).status).toBe(400);
    expect((await send({ input: [{ type: "item_reference", id: "item_1" }] })).status).toBe(400);
    expect(fx.sent).toHaveLength(1);
  });

  it("keeps explicit routes and restricted pooled aliases separate", async () => {
    fx.allow = ["gpt-6.1-sol@standard"];
    expect((await send()).status).toBe(200);
    expect((await send({}, "cx/gpt-6.1-sol@standard")).status).toBe(403);
    expect((await send({}, "openai/gpt-6.1-sol@standard")).status).toBe(403);
    fx.allow = ["cx/gpt-6.1-sol@standard"];
    expect((await send()).status).toBe(403);
    expect((await send({}, "cx/gpt-6.1-sol@standard")).status).toBe(200);
    expect(fx.sent.map(s => s.account)).toEqual(["api", "oauth"]);
  });

  it("resolves a saved logical alias without duplicating the provider prefix", async () => {
    fx.aliases = { shared: "studio-openai/gpt-6.1-sol" };
    expect((await send({}, "shared@fast")).status).toBe(200);
    expect(fx.sent[0].body.model).toBe("gpt-6.1-sol");
  });

  it("permits a single concurrent recovery probe and restores API-first after success", async () => {
    fx.replies.push(failure("credit_balance_exhausted")); await send();
    await reopenOpenaiBilling("api");
    const options = { requestControls: { provider: "openai", model: "gpt-6.1-sol", effort: "max", tier: "default" } };
    const selections = await Promise.all(Array.from({ length: 8 }, () => getProviderCredentials("openai", null, "gpt-6.1-sol", options)));
    expect(selections.filter(s => s?.connectionId === "api")).toHaveLength(1);
    releaseBillingRetry("api"); fx.accounts[0].studioBillingState.probeUntil = null;
    const response = await send(); await response.text();
    expect(fx.accounts[0].studioBillingState).toBeNull();
    expect(response.headers.get("x-9router-serving-provider")).toBe("openai");
  });

  it("only falls back on a failure before any model output", async () => {
    fx.replies.push(sse(frame({ type: "response.failed", response: { error: { code: "credit_balance_exhausted", type: "insufficient_quota" } } })));
    expect((await send({ stream: true })).headers.get("x-9router-serving-provider")).toBe("codex");
  });

  it.each([true, false])("never replays after reasoning starts (stream=%s)", async stream => {
    fx.replies.push(sse(frame({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r1", summary: [] } })
      + frame({ type: "response.failed", response: { error: { code: "credit_balance_exhausted" } } })));
    const response = await send({ stream });
    await response.text().catch(() => {});
    expect(fx.sent).toHaveLength(1);
    expect(fx.accounts[0].studioBillingState).toBeUndefined();
  });
});

describe("OpenAI stream envelopes", () => {
  it("handles event-only errors, CRLF, split frames and a final frame without a separator", async () => {
    const input = 'event: response.failed\r\ndata: {"response":{"error":{"code":"credit_balance_exhausted"}}}';
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({ start(c) {
      for (let i = 0; i < input.length; i += 3) c.enqueue(encoder.encode(input.slice(i, i + 3))); c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
    expect((await preflightOpenaiStream(response)).status).toBe(429);
  });
  it("does not interpret words inside model output as an error", async () => {
    const text = frame({ type: "response.output_text.delta", delta: '{"error":{"code":"credit_balance_exhausted"}}' });
    expect(await (await preflightOpenaiStream(sse(text))).text()).toBe(text);
  });
  it("forwards cancellation to the upstream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame({ type: "response.output_text.delta", delta: "hi" }))); }, cancel }),
      { headers: { "content-type": "text/event-stream" } });
    await (await preflightOpenaiStream(response)).body.cancel(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("keeps Chat Completions usage after finish_reason and rejects incomplete JSON", async () => {
    const events = [];
    const controls = { provider: "openai", tier: "default", effort: null };
    const response = await observeControlResponse(sse(frame({ choices: [{ finish_reason: "stop" }], service_tier: "default" })
      + frame({ choices: [], usage: { total_tokens: 2 } }) + "data: [DONE]\n\n"), controls, async e => events.push(e));
    expect(await response.text()).toContain("total_tokens");
    expect(events.at(-1).state).toBe("completed");
    await expect(observeControlResponse(Response.json({ status: "incomplete" }), controls)).rejects.toThrow("did not complete");
  });
  it("distinguishes billing codes from the broad quota type", () => {
    expect(classifyOpenaiFailure(429, "slow_down", "insufficient_quota")).toBe("capacity");
    expect(classifyOpenaiFailure(429, null, "insufficient_quota")).toBe("billing");
  });
  it("publishes the existing six picker aliases with compatible context", () => {
    const catalog = studioModelCatalog(OPENAI_POOL_MODELS.map(id => ({ id: `openai/${id}`, context_length: 1050000 })));
    expect(catalog).toHaveLength(6);
    expect(catalog.every(m => !m.id.includes("/") && m.context_length === 272000)).toBe(true);
  });
});
