import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { getModelUpstreamId, getProviderModels } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { studioModelCatalog } from "../../open-sse/services/studioCatalog.js";
import { validateLithosKey, lithosKimiModels } from "../../open-sse/services/lithosai.js";

const accounts = vi.hoisted(() => ({ get: vi.fn(), fail: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: true }),
  getModelAliases: async () => ({}), getComboByName: async () => null,
  getProviderNodes: async () => [], getProviderConnectionById: async () => null,
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async () => ({ id: "fixture", access: { restricted: false } }),
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: accounts.get, markAccountUnavailable: accounts.fail,
  clearAccountError: vi.fn(), extractApiKey: request => request.headers.get("authorization")?.slice(7),
  isValidApiKey: async key => key === "normal-client-key",
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials, updateProviderCredentials: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async original => ({
  ...await original(), proxyAwareFetch: (url, options) => global.fetch(url, options),
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

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
const { POST: postResponses } = await import("../../src/app/api/v1/responses/route.js");
const slug = "kimi-k3.1-pro-ultra";
const upstreamModel = "moonshotai/Kimi-K3.1-Pro-ultra";
const route = `lithosai/${slug}`;
const base = "https://api.lithosai.cloud/v1";
const completion = {
  id: "chatcmpl-fixture", object: "chat.completion", model: upstreamModel,
  choices: [{ index: 0, message: { role: "assistant", content: "OK", reasoning_content: "Checked" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
};
const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } };
const call = { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } };
const image = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };

async function chat(fields = {}, id = slug, format = "openai") {
  return handleChatCore({
    body: { model: `lithosai/${id}`, stream: false, messages: [{ role: "user", content: "hi" }], ...fields },
    modelInfo: { provider: "lithosai", model: id }, credentials: { apiKey: "fixture", providerSpecificData: {} },
    connectionId: "lithos-fixture", sourceFormatOverride: format,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
}

function sent() {
  const [url, options] = global.fetch.mock.calls.at(-1);
  expect(url).toBe(`${base}/chat/completions`);
  expect(options.headers.Authorization).toBe("Bearer fixture");
  return JSON.parse(options.body);
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json(completion))));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Lithos quota headers on the normal chat route", () => {
  const quota = {
    "x-ratelimit-limit-requests": "501", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "17s",
    "x-ratelimit-limit-tokens": "900001", "x-ratelimit-remaining-tokens": "400007", "x-ratelimit-reset-tokens": "3m17s",
  };
  const extras = { "x-ratelimit-private": "discard", "set-cookie": "discard", "authorization": "discard" };
  const upstreamCors = { "access-control-expose-headers": "authorization, x-ratelimit-private", "access-control-allow-origin": "https://provider.test" };
  beforeEach(() => {
    accounts.get.mockReset().mockResolvedValue({ connectionId: "lithos-test", apiKey: "fixture", providerSpecificData: {} });
    accounts.fail.mockReset().mockResolvedValue({ shouldFallback: false });
  });
  function request(stream = false, model = route) {
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer normal-client-key", origin: "https://client.test" },
      body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hello" }] }),
    });
  }
  function checkHeaders(response, expected) {
    for (const key of Object.keys(quota)) expect(response.headers.get(key)).toBe(expected[key] ?? null);
    for (const header of Object.keys(extras)) expect(response.headers.has(header)).toBe(false);
    const exposed = (response.headers.get("access-control-expose-headers") || "").split(",").map(name => name.trim()).filter(Boolean).sort();
    expect(exposed).toEqual(Object.keys(expected).sort());
    if (exposed.length) expect(response.headers.get("access-control-allow-origin")).toBe("*");
  }
  it("forwards supplied values on JSON and SSE without buffering or inventing missing counters", async () => {
    global.fetch.mockResolvedValueOnce(Response.json(completion, { headers: { ...quota, ...extras, ...upstreamCors } }));
    const regular = await POST(request());
    expect(regular.status).toBe(200);
    checkHeaders(regular, quota);
    expect((await regular.json()).choices[0].message.content).toBe("OK");

    const partial = { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-tokens": "90ms" };
    const frame = { id: "fixture", object: "chat.completion.chunk", model: upstreamModel,
      choices: [{ index: 0, delta: { content: "SSE content" }, finish_reason: "stop" }] };
    let feed;
    const delayed = new ReadableStream({ start(controller) { feed = controller; } });
    global.fetch.mockResolvedValueOnce(new Response(delayed, {
      headers: { "content-type": "text/event-stream", ...partial, ...extras },
    }));
    const stream = await POST(request(true));
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    checkHeaders(stream, partial);
    feed.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`));
    feed.close();
    expect(await stream.text()).toContain("SSE content");
  });
  it("preserves upstream Retry-After and actionable errors through account exhaustion", async () => {
    global.fetch.mockResolvedValueOnce(Response.json({ error: { message: "Request capacity exhausted" } },
      { status: 429, headers: { ...quota, ...extras, "retry-after": "17" } }));
    accounts.get.mockReset().mockResolvedValueOnce({ connectionId: "lithos-test", apiKey: "fixture", providerSpecificData: {} }).mockResolvedValueOnce(null);
    accounts.fail.mockResolvedValueOnce({ shouldFallback: true });
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    checkHeaders(limited, quota);
    expect(limited.headers.get("retry-after")).toBe("17");
    expect((await limited.json()).error.message).toContain("Request capacity exhausted");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards counters on translated Responses requests and direct HTTP input errors", async () => {
    const partial = { "x-ratelimit-limit-tokens": "500000" };
    global.fetch.mockResolvedValueOnce(Response.json(completion, { headers: { ...partial, ...extras } }));
    const response = await postResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer normal-client-key" },
      body: JSON.stringify({ model: route, input: "hello", stream: false }),
    }));
    expect(response.status).toBe(200);
    checkHeaders(response, partial);
    expect((await response.json()).object).toBe("response");

    global.fetch.mockResolvedValueOnce(Response.json({ error: { message: "Unsupported request field" } },
      { status: 400, headers: { ...partial, ...extras } }));
    const error = await POST(request(true));
    expect(error.status).toBe(400);
    checkHeaders(error, partial);
    expect((await error.json()).error.message).toContain("Unsupported request field");
  });
  it("retains last upstream quota and the gateway retry deadline when every account is cooling down", async () => {
    const retryAfter = new Date(Date.now() + 90000).toISOString();
    accounts.get.mockReset().mockResolvedValueOnce({ connectionId: "a", apiKey: "fixture", providerSpecificData: {} })
      .mockResolvedValueOnce({ allRateLimited: true, retryAfter, retryAfterHuman: "try again after cooling down" });
    accounts.fail.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch.mockResolvedValueOnce(Response.json({ error: { message: "Token budget exhausted" } },
      { status: 429, headers: { ...quota, ...extras, "retry-after": "132" } }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    checkHeaders(response, quota);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(85);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(90);
    expect((await response.json()).error.message).toContain("Token budget exhausted");
  });
  it("returns only the winning account counters after a retry", async () => {
    accounts.get.mockReset().mockResolvedValueOnce({ connectionId: "a", apiKey: "fixture-a", providerSpecificData: {} })
      .mockResolvedValueOnce({ connectionId: "b", apiKey: "fixture-b", providerSpecificData: {} });
    accounts.fail.mockResolvedValueOnce({ shouldFallback: true });
    const winningQuota = { "x-ratelimit-remaining-tokens": "43" };
    global.fetch.mockResolvedValueOnce(Response.json({ error: { message: "First account exhausted" } }, { status: 429, headers: quota }))
      .mockResolvedValueOnce(Response.json(completion, { headers: winningQuota }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    checkHeaders(response, winningQuota);
  });
  it("carries documented counters through a response-conversion failure", async () => {
    global.fetch.mockResolvedValueOnce(new Response("malformed provider JSON", {
      headers: { ...quota, ...extras, "content-type": "application/json" },
    }));
    const response = await POST(request());
    expect(response.status).toBe(502);
    checkHeaders(response, quota);
    expect((await response.json()).error.message).toMatch(/invalid JSON/i);
  });
  it("keeps other provider response headers unchanged", async () => {
    global.fetch.mockResolvedValueOnce(Response.json(completion, { headers: { ...quota, ...extras } }));
    const response = await POST(request(false, "moonshot/kimi-k3.1-pro"));
    expect(response.status).toBe(200);
    checkHeaders(response, {});
  });
});

describe("LithosAI Kimi API discovery and catalog", () => {
  it("maps the stable picker ID to the provider-qualified Ultra model", async () => {
    vi.stubEnv("STUDIO_CURATED_CATALOG", "1");
    for (const id of [route, slug]) expect(await getModelInfoCore(id, {})).toEqual({ provider: "lithosai", model: slug });
    expect(getModelUpstreamId("lithosai", `${slug}(max)`)).toBe(`${upstreamModel}(max)`);
    expect(getProviderModels("lithosai").map(m => m.id)).toEqual([slug]);
    for (const id of [slug, upstreamModel]) {
      expect(getThinkingLevels("lithosai", id)).toEqual(["low", "high", "max"]);
      expect(getCapabilitiesForModel("lithosai", id)).toMatchObject({ contextWindow: 1048576, reasoning: true, tools: true, vision: true, videoInput: false });
      expect(getPricingForModel("lithosai", id)).toMatchObject({ input: 6, cached: 0.3, output: 30 });
    }
    const price = getPricingForModel("lithosai", `${slug}(max)`);
    expect(calculateCostFromTokens({ prompt_tokens: 1000, cached_tokens: 100, completion_tokens: 400, reasoning_tokens: 150 }, price,
      { provider: "lithosai", model: slug })).toBeCloseTo((900 * 6 + 100 * 0.3 + 400 * 30) / 1e6, 8);
    const available = [{ id: route, owned_by: "lithosai" }, { id: "moonshot/kimi-k3.1-pro" }];
    expect(studioModelCatalog(available).map(m => m.id)).toEqual(["moonshot/kimi-k3.1-pro", route]);
    expect(studioModelCatalog(available).at(-1)).toMatchObject({ owned_by: "lithosai", context_length: 1048576, capabilities: { effort: {
      low: { supported: true }, high: { supported: true }, max: { supported: true },
    } } });
    expect(studioModelCatalog(available, { anthropic: true })).toEqual([]);
    expect(studioModelCatalog([available[1]]).map(m => m.id)).toEqual(["moonshot/kimi-k3.1-pro"]);
  });

  it("validates the key with only authenticated model discovery and maps entitlement to the public route", async () => {
    const models = { data: [{ id: "deepseek-ai/other" }, { id: upstreamModel, object: "model" }] };
    global.fetch.mockImplementationOnce(async () => Response.json(models));
    expect(await validateLithosKey("fixture")).toEqual({ valid: true, error: null });
    expect(global.fetch).toHaveBeenCalledWith(`${base}/models`, expect.objectContaining({
      method: "GET", redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer fixture" }),
    }));
    expect(lithosKimiModels(models)).toMatchObject([{ id: slug, upstreamModelId: upstreamModel, thinkingLevels: ["low", "high", "max"] }]);
    for (const payload of [{ data: [] }, { data: [{ id: "other" }] }, {}]) {
      global.fetch.mockImplementationOnce(async () => Response.json(payload));
      expect((await validateLithosKey("fixture")).valid).toBe(false);
    }
    global.fetch.mockImplementationOnce(async () => new Response(null, { status: 429 }));
    expect((await validateLithosKey("fixture")).error).toContain("429");
    expect(global.fetch.mock.calls.every(([url, options]) => url === `${base}/models` && options.method === "GET")).toBe(true);
  });
});

describe("LithosAI Kimi inference", () => {
  it.each(["low", "high", "max"])("forwards %s, the image, tool schemas, actual prior reasoning and tool results", async effort => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "identify" }, image] },
      { role: "assistant", content: null, reasoning_content: "Need lookup", tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "square" },
    ];
    const response_format = { type: "json_schema", json_schema: {
      name: "shape", strict: true, schema: { type: "object", properties: { shape: { type: "string" } }, required: ["shape"], additionalProperties: false },
    } };
    const result = await chat({ messages, reasoning_effort: effort, tool_choice: "auto", tools: [tool], response_format });
    expect(result.success).toBe(true);
    expect(sent()).toMatchObject({ model: upstreamModel, reasoning_effort: effort, messages, tool_choice: "auto", tools: [tool], response_format });
    const response = await result.response.json();
    expect(response.choices[0].message).toMatchObject({ content: "OK", reasoning_content: "Checked" });
    expect(response.usage).toMatchObject(completion.usage);
  });

  it("keeps the API default on auto and translates Responses-format effort and output limit to Chat", async () => {
    expect((await chat({ reasoning_effort: "auto" })).success).toBe(true);
    expect(sent()).not.toHaveProperty("reasoning_effort");
    expect((await chat({ messages: undefined, input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "max" }, max_output_tokens: 512 }, slug, "openai-responses")).success).toBe(true);
    expect(sent()).toMatchObject({ model: upstreamModel, reasoning_effort: "max", max_tokens: 512, messages: [{ role: "user", content: "hello" }] });
  });

  it("replays a Responses client's reasoning summary, function call and function result together", async () => {
    const input = [
      { role: "user", content: "lookup" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Need lookup" }] },
      { type: "function_call", call_id: call.id, name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: call.id, output: "square" },
    ];
    const result = await chat({ messages: undefined, input, reasoning: { effort: "high" } }, slug, "openai-responses");
    expect(result.success).toBe(true);
    expect(sent().messages).toMatchObject([{ role: "user" },
      { role: "assistant", reasoning_content: "Need lookup", tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "square" }]);
  });

  it("rejects invalid controls before contacting the provider", async () => {
    for (const effort of ["medium", "xhigh", "none", "ultra"]) expect((await chat({ reasoning_effort: effort })).status).toBe(400);
    expect((await chat({ thinking: { type: "enabled", budget_tokens: 32 } })).status).toBe(400);
    expect((await chat({ reasoning_effort: "low" }, `${slug}(max)`)).status).toBe(400);
    expect((await chat({}, `${slug}(typo)`)).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported replayed attachments while preserving ordinary text that mentions data URIs", async () => {
    const messages = [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] },
      { role: "assistant", content: "previous answer" }, { role: "user", content: "follow up" }];
    expect((await chat({ messages })).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await chat({ messages: [{ role: "user", content: "Explain data:audio/wav syntax" }] })).success).toBe(true);
  });

  it("preserves native video_url bytes and surfaces the provider's video rejection", async () => {
    const video = { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAAZHRlc3Q=" } };
    const messages = [{ role: "user", content: [{ type: "text", text: "Identify the colors." }, video] }];
    global.fetch.mockImplementationOnce(async () => Response.json({ error: { type: "bad_request", message: "Invalid image" } }, { status: 400 }));
    const result = await chat({ messages });
    expect(result.status).toBe(400);
    expect(result.error).toContain("Invalid image");
    expect(sent().messages).toEqual(messages);
    global.fetch.mockClear();
    expect((await chat({ messages: [{ role: "user", content: [{ type: "input_video", video_url: video.video_url.url }] }] })).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns interleaved thinking, streamed tool arguments, terminal usage and DONE in order", async () => {
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Check " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call, function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: completion.usage },
    ];
    const wire = frames.map(frame => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", model: upstreamModel, ...frame })}\n\n`).join("") + "data: [DONE]\n\n";
    global.fetch.mockImplementationOnce(async () => new Response(wire, { headers: { "Content-Type": "text/event-stream" } }));
    const result = await chat({ stream: true, stream_options: { include_usage: true }, reasoning_effort: "high", tools: [tool] });
    expect(result.success).toBe(true);
    expect(sent()).toMatchObject({ model: upstreamModel, stream: true, tools: [tool], stream_options: { include_usage: true } });
    const lines = (await result.response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6));
    expect(lines.at(-1)).toBe("[DONE]");
    const chunks = lines.slice(0, -1).map(line => JSON.parse(line));
    expect(chunks.flatMap(chunk => chunk.choices || []).map(choice => choice.delta?.reasoning_content || "").join("")).toBe("Check ");
    expect(chunks.flatMap(chunk => chunk.choices || []).flatMap(choice => choice.delta?.tool_calls || [])
      .map(entry => entry.function.arguments).join("")).toBe("{}");
    expect(chunks.some(chunk => chunk.choices?.some(choice => choice.finish_reason === "tool_calls"))).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: completion.usage });
    expect(chunks.filter(chunk => chunk.usage)).toHaveLength(1);
  });
});
