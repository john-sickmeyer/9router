import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseModel } from "../../open-sse/services/model.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getProviderModels } from "../../open-sse/config/providerModels.js";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(), updateConnection: vi.fn(), resolveProxy: vi.fn(), testProxy: vi.fn(),
  proxyFetch: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: {
  json: (body, init = {}) => new Response(JSON.stringify(body), {
    status: init.status || 200, headers: { "Content-Type": "application/json" },
  }),
} }));
vi.mock("@/models", () => ({
  getProviderNodeById: vi.fn(), getProviderConnectionById: mocks.getConnection,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getConnection, updateProviderConnection: mocks.updateConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxy }));
vi.mock("../../open-sse/utils/proxyFetch.js", async (original) => ({
  ...await original(), proxyAwareFetch: mocks.proxyFetch,
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

const originalFetch = global.fetch;
const { POST: validateProvider } = await import("../../src/app/api/providers/validate/route.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { GET: listModels } = await import("../../src/app/api/providers/[id]/models/route.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getUsageForProvider } = await import("../../open-sse/services/usage.js");

const connection = { id: "platform", provider: "moonshot", authType: "apikey", apiKey: "platform-key", providerSpecificData: {} };
const models = { data: [{ id: "kimi-k3", context_length: 1048576,
  reasoning_efforts: { valid_efforts: ["low", "high", "max"], default_effort: "max" } }] };
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const validate = () => validateProvider(new Request("http://localhost/api/providers/validate", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "moonshot", apiKey: connection.apiKey }),
}));
const chat = (body = {}, model = "kimi-k3", sourceFormat = "openai") => handleChatCore({
  body: { model: `moonshot/${model}`, stream: false, messages: [{ role: "user", content: "hi" }], ...body },
  modelInfo: { provider: "moonshot", model }, credentials: { apiKey: connection.apiKey, providerSpecificData: {} },
  connectionId: connection.id, sourceFormatOverride: sourceFormat,
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
});

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
  mocks.proxyFetch.mockImplementation((url, options) => global.fetch(url, options));
  mocks.getConnection.mockResolvedValue({ ...connection });
  mocks.updateConnection.mockResolvedValue(undefined);
  mocks.resolveProxy.mockResolvedValue({});
  mocks.testProxy.mockResolvedValue({ ok: true });
});
afterAll(() => { global.fetch = originalFetch; });

describe("Kimi API Platform connection routes", () => {
  it("validates and tests saved keys with a free authenticated GET, never Code inference", async () => {
    global.fetch.mockImplementation(async () => response(models));
    expect(await (await validate()).json()).toEqual({ valid: true, error: null });
    expect((await testSingleConnection(connection.id)).valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of global.fetch.mock.calls) {
      expect(url).toBe("https://api.moonshot.ai/v1/models");
      expect(options.method).toBe("GET");
      expect(options.headers.Authorization).toBe("Bearer platform-key");
      expect(options.headers["x-api-key"]).toBeUndefined();
      expect(options.body).toBeUndefined();
      expect(options.redirect).toBe("error");
    }
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id,
      expect.objectContaining({ testStatus: "active", lastError: null }));
  });

  it.each([401, 403, 429, 500, 503])("handles HTTP %s consistently without a paid fallback", async (status) => {
    global.fetch.mockImplementation(async () => response({}, status));
    const added = await (await validate()).json();
    const saved = await testSingleConnection(connection.id);
    expect(added.valid).toBe(false);
    expect(saved.valid).toBe(false);
    expect(saved.error).toBe(added.error);
    expect(added.error).toContain(status === 401 || status === 403 ? "rejected this key" : `HTTP ${status}`);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { data: {} }, { data: [null] }, { data: [{ id: " " }] }])("rejects malformed successful responses: %j", async (payload) => {
    global.fetch.mockImplementation(async () => response(payload));
    expect((await (await validate()).json()).valid).toBe(false);
    expect((await testSingleConnection(connection.id)).valid).toBe(false);
  });

  it("does not leak fetch error details or misclassify a timeout as bad credentials", async () => {
    global.fetch.mockRejectedValue(new Error("private platform-key fetch details"));
    const payload = await (await validate()).json();
    expect(payload).toEqual({ valid: false, error: "Unable to reach Kimi API Platform. Check the connection and try again." });
  });

  it("honors the saved connection proxy", async () => {
    mocks.resolveProxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" });
    global.fetch.mockResolvedValue(response(models));
    expect((await testSingleConnection(connection.id)).valid).toBe(true);
    expect(mocks.proxyFetch).toHaveBeenCalledWith("https://api.moonshot.ai/v1/models", expect.any(Object),
      expect.objectContaining({ connectionProxyUrl: "http://proxy:8080" }));
  });

  it("discovers live models and their real effort metadata", async () => {
    global.fetch.mockResolvedValue(response(models));
    const result = await listModels(new Request("http://localhost/api/providers/platform/models"),
      { params: Promise.resolve({ id: connection.id }) });
    expect(await result.json()).toMatchObject({ provider: "moonshot", models: [{
      id: "kimi-k3", contextLength: 1048576, thinkingLevels: ["low", "high", "max"],
    }] });
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.moonshot.ai/v1/models");
  });

  it("keeps Code keys and Platform model IDs separate", async () => {
    mocks.getConnection.mockResolvedValue({ ...connection, provider: "kimi" });
    global.fetch.mockResolvedValue(response({}));
    expect((await testSingleConnection(connection.id)).valid).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.kimi.com/coding/v1/messages");
    expect(global.fetch.mock.calls[0][1].headers["x-api-key"]).toBe("platform-key");
    expect(getProviderModels("kimi").some((m) => m.id === "kimi-k3")).toBe(false);
    expect(parseModel("moonshot/kimi-k3")).toMatchObject({ provider: "moonshot", model: "kimi-k3" });
  });
});

describe("Platform inference through the real chat handler and executor", () => {
  beforeEach(() => {
    global.fetch.mockImplementation(async () => response({
      id: "chatcmpl-1", object: "chat.completion", model: "kimi-k3",
      choices: [{ index: 0, message: { role: "assistant", content: "OK", reasoning_content: "Checked." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  it.each(["low", "high", "max"])("sends %s unchanged to Moonshot and preserves tool history", async (effort) => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", reasoning_content: "Need a tool.",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ];
    const result = await chat({ messages, reasoning_effort: effort, max_tokens: 2000,
      temperature: 0.2, top_p: 0.5, n: 2, presence_penalty: 1, frequency_penalty: 1 });
    expect(result.success).toBe(true);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer platform-key");
    expect(options.headers["x-api-key"]).toBeUndefined();
    expect(Object.keys(options.headers).some((key) => key.toLowerCase().startsWith("x-msh-"))).toBe(false);
    const sent = JSON.parse(options.body);
    expect(sent).toMatchObject({ model: "kimi-k3", reasoning_effort: effort, max_completion_tokens: 2000 });
    expect(sent.messages[1]).toMatchObject(messages[1]);
    expect(sent.messages[2]).toEqual(messages[2]);
    for (const key of ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty", "max_tokens"]) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it.each(["medium", "none", "minimal", "xhigh", "ultra"])("rejects unsupported %s before sending a request", async (effort) => {
    const result = await chat({ reasoning_effort: effort });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported suffixes and conflicting explicit efforts", async () => {
    expect((await chat({}, "kimi-k3(medium)")).status).toBe(400);
    expect((await chat({ reasoning_effort: "low" }, "kimi-k3(max)")).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("leaves automatic reasoning to the API default", async () => {
    expect((await chat({ reasoning_effort: "auto" })).success).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty("reasoning_effort");
    expect(getThinkingLevels("moonshot", "kimi-k3.1-pro-highspeed")).toEqual(["low", "high", "max"]);
  });

  it("translates Responses clients to Platform chat, without using Code /responses", async () => {
    const result = await chat({ messages: undefined, input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "low" } }, "kimi-k3", "openai-responses");
    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] });
  });
});

describe("Platform balance", () => {
  it("uses the pay-as-you-go balance without claiming subscription resets", async () => {
    global.fetch.mockResolvedValue(response({ code: 0, status: true,
      data: { available_balance: 55, cash_balance: 50, voucher_balance: 5 } }));
    expect(await getUsageForProvider(connection)).toMatchObject({ plan: "Kimi API Platform", quotas: {
      "Balance (USD)": { total: 55, resetAt: null, isCreditBalance: true, currency: "USD" },
    } });
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.moonshot.ai/v1/users/me/balance");
  });

  it.each([{}, { code: 1, status: false },
    ...[null, true, " "].map((available_balance) => ({ code: 0, status: true, data: { available_balance } })),
  ])("does not turn a failed balance response into a zero balance: %j", async (body) => {
    global.fetch.mockResolvedValue(response(body));
    expect(await getUsageForProvider(connection)).not.toHaveProperty("quotas");
  });
});
