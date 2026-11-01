import { describe, it, expect } from "vitest";
import { splitControlModel, resolveControls, applyControls, assertOutboundControls, connectionSupportsControls } from "../../open-sse/services/studioControls.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const capable = (tiers) => ({ provider: "codex", providerSpecificData: { studioCapabilities: { checkedAt: new Date().toISOString(), models: { "gpt-6-astra": { tiers, efforts: ["max", "ultra"] } } } } });
describe("Studio request controls", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("preserves %s through alias resolution and the real executor", effort => {
    const parsed = splitControlModel(`cx/gpt-6-astra@ultrafast(${effort})`);
    const controls = resolveControls("codex", "gpt-6-astra", {}, parsed);
    const body = new CodexExecutor().transformRequest("gpt-6-astra", applyControls({ input: "hi" }, controls), true, {});
    expect(body.reasoning.effort).toBe(effort);
    expect(body.service_tier).toBe("ultrafast");
    expect(() => assertOutboundControls(body, controls)).not.toThrow();
  });
  it("accepts matching native fields, retains reasoning metadata", () => {
    const controls = resolveControls("codex", "gpt-6.1-sol", { service_tier: "fast", reasoning: { effort: "max" } }, { speed: "fast", effort: "max" });
    const body = applyControls({ reasoning: { summary: "detailed", effort: "low" } }, controls);
    expect(body).toEqual({ service_tier: "priority", reasoning: { summary: "detailed", effort: "max" } });
  });
  it.each([
    [{ reasoning_effort: "low" }, { effort: "max" }],
    [{ service_tier: "priority" }, { speed: "ultrafast" }],
    [{ service_tier: "typo" }, {}],
    [{ reasoning: { effort: "typo" } }, {}],
  ])("rejects conflicting or invalid controls", (body, alias) => {
    expect(() => resolveControls("codex", "gpt-6-astra", body, alias)).toThrow();
  });
  it.each(["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"])("explains native Ultra orchestration for %s instead of silently mapping effort", model => {
    expect(() => resolveControls("codex", model, { reasoning_effort: "ultra" })).toThrow(/runtime orchestration mode/);
  });
  it("keeps explicit client effort over the provider default", () => {
    expect(resolveControls("codex", "gpt-6-astra", { reasoning_effort: "max" }, {}, { mode: "low" }).effort).toBe("max");
  });
  it("sets Claude native effort and rejects credit-spending Fast requests", () => {
    const controls = resolveControls("claude", "claude-opus-5-5", { output_config: { effort: "xhigh" }, speed: "standard" });
    expect(applyControls({}, controls)).toEqual({ speed: "standard", output_config: { effort: "xhigh" } });
    expect(() => resolveControls("claude", "claude-opus-5-5", { speed: "fast" })).toThrow(/extra-usage credits/);
    expect(() => resolveControls("claude", "claude-opus-5-5@fast", {})).toThrow(/extra-usage credits/);
    expect(() => resolveControls("anthropic", "claude-opus-5-5", {}, { speed: "fast" })).toThrow(/extra-usage credits/);
    expect(() => resolveControls("claude", "claude-opus-4-6", { speed: "fast" })).toThrow();
  });
  it("admits every Codex account regardless of missing, stale or previously restricted capability metadata", () => {
    const c = { provider: "codex", model: "gpt-6-astra", tier: "ultrafast", effort: "max" };
    for (const account of [{}, capable(["priority"]), capable(["priority", "ultrafast"]),
      { providerSpecificData: { studioCapabilities: { checkedAt: "invalid", models: { "gpt-6-astra": { tiers: [], efforts: [] } } } } }]) {
      expect(connectionSupportsControls(account, c, Date.now() + 7 * 3600000)).toBe(true);
    }
  });
  it("retains the independent OpenAI API model availability check", () => {
    const controls = { provider: "openai", model: "gpt-6-astra", tier: "ultrafast", effort: "max" };
    expect(connectionSupportsControls({}, controls)).toBe(false);
    expect(connectionSupportsControls(capable([]), controls)).toBe(true);
    expect(connectionSupportsControls(capable([]), controls, Date.now() + 7 * 3600000)).toBe(false);
  });
});
