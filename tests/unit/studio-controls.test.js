import { describe, it, expect } from "vitest";
import { splitControlModel, resolveControls, applyControls, assertOutboundControls, connectionSupportsControls, expandControlModels } from "../../open-sse/services/studioControls.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const capable = (tiers) => ({ provider: "codex", providerSpecificData: { studioCapabilities: { checkedAt: new Date().toISOString(), models: { "gpt-6-astra": { tiers, efforts: ["max", "ultra"] } } } } });
describe("Studio request controls", () => {
  it.each(["low", "medium", "high", "xhigh", "max", "ultra"])("preserves %s through alias resolution and the real executor", effort => {
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
  it("rejects unsupported Ultra instead of changing it to Max", () => {
    expect(() => resolveControls("codex", "gpt-6-luna", { reasoning_effort: "ultra" })).toThrow(/Unsupported effort/);
  });
  it("keeps explicit client effort over the provider default", () => {
    expect(resolveControls("codex", "gpt-6-astra", { reasoning_effort: "max" }, {}, { mode: "low" }).effort).toBe("max");
  });
  it("sets Claude native fields and rejects unsupported fast models", () => {
    const controls = resolveControls("claude", "claude-opus-5", { output_config: { effort: "xhigh" }, speed: "fast" });
    expect(applyControls({}, controls)).toEqual({ speed: "fast", output_config: { effort: "xhigh" } });
    expect(() => resolveControls("claude", "claude-opus-4-6", { speed: "fast" })).toThrow();
  });
  it("does not admit a Pro-only or stale account to Ultrafast", () => {
    const c = { provider: "codex", model: "gpt-6-astra", tier: "ultrafast", effort: "max" };
    expect(connectionSupportsControls(capable(["priority"]), c)).toBe(false);
    const eligible = capable(["priority", "ultrafast"]);
    expect(connectionSupportsControls(eligible, c)).toBe(true);
    expect(connectionSupportsControls(eligible, c, Date.now() + 7 * 3600000)).toBe(false);
  });
  it("advertises only eligible accelerated aliases", () => {
    const models = [{ id: "cx/gpt-6-astra" }];
    expect(expandControlModels(models, [capable(["priority"])]).some(m => m.id.includes("ultrafast"))).toBe(false);
    expect(expandControlModels(models, [capable(["ultrafast"])]).some(m => m.id === "cx/gpt-6-astra@ultrafast(max)")).toBe(true);
  });
});
