import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { getModelUpstreamId, getProviderModels } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { studioModelCatalog } from "../../open-sse/services/studioCatalog.js";
import { validateLithosKey, lithosKimiModels } from "../../open-sse/services/lithosai.js";

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
