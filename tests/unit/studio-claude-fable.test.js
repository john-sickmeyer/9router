import { describe, expect, it } from "vitest";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { resolveControls, applyControls } from "../../open-sse/services/studioControls.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

import { DefaultExecutor } from "../../open-sse/executors/default.js";

const MODEL = "claude-fable-5-2";

describe("Studio Claude Fable 5.2", () => {
  it("uses a supported Claude Code version for gateway clients without native headers", () => {
    const headers = new DefaultExecutor("claude").buildHeaders({ accessToken: "test" }, true, undefined, MODEL);
    expect(headers["User-Agent"]).toBe("claude-cli/2.1.321 (external, sdk-cli)");
  });
  it("registers the canonical model with its native capabilities and prices", () => {
    expect(getModelsByProviderId("claude")).toContainEqual({ id: MODEL, name: "Claude Fable 5.2" });
    expect(getCapabilitiesForModel("claude", MODEL)).toMatchObject({
      vision: true, pdf: true, reasoning: true, thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false, forcedToolChoice: false,
      contextWindow: 1000000, maxOutput: 128000,
    });
    expect(getPricingForModel("claude", MODEL)).toEqual({
      input: 8, output: 40, cached: 0.2, reasoning: 40, cache_creation: 10,
    });
    expect(getThinkingLevels("claude", MODEL)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("preserves %s effort through the request pipeline", (effort) => {
    const controls = resolveControls("claude", MODEL, { output_config: { effort } });
    const body = applyControls({ model: MODEL, messages: [{ role: "user", content: "hi" }] }, controls);
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, MODEL, body, true, null, "claude");
    expect(translated.output_config.effort).toBe(effort);
    expect(translated.thinking?.type).not.toBe("disabled");
  });

  it("normalizes incompatible OpenAI thinking and forced tool controls", () => {
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, MODEL, {
      model: MODEL, reasoning_effort: "none", tool_choice: "required",
      tools: [{ type: "function", function: { name: "check", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(translated.output_config.effort).toBe("low");
    expect(translated.thinking?.type).not.toBe("disabled");
    expect(translated.tool_choice.type).toBe("auto");
  });
});
