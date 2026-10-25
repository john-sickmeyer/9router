import { describe, it, expect, vi } from "vitest";
import { studioModelCatalog } from "../../open-sse/services/studioCatalog.js";
import { resolveControls } from "../../open-sse/services/studioControls.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";

const models = [
  "cx/gpt-6.1-sol", "cx/gpt-6-astra", "cx/gpt-6-sol", "cc/claude-opus-5-5",
  "cc/claude-fable-5-1", "cc/claude-sonnet-5-5", "cc/claude-opus-5-5@fast(max)",
  "cx/gpt-6-astra@ultrafast(max)", "free/example", "cx/gpt-6.1-sol",
].map(id => ({ id, context_length: 200000, max_completion_tokens: 32000, capabilities: { vision: true } }));

describe("Studio picker catalog", () => {
  it("advertises exactly two models per provider, with no duplicate or control aliases", () => {
    expect(studioModelCatalog(models).map(m => m.id)).toEqual([
      "cx/gpt-6.1-sol", "cx/gpt-6-astra", "cc/claude-opus-5-5", "cc/claude-fable-5-1",
    ]);
  });
  it("provides Anthropic effort capabilities to Happier and excludes other providers", () => {
    const catalog = studioModelCatalog(models, { anthropic: true });
    expect(catalog).toHaveLength(2);
    for (const model of catalog) {
      expect(model.id).toMatch(/^claude-/);
      expect(model.display_name).toMatch(/^Claude /);
      expect(model.max_input_tokens).toBe(200000);
      expect(model.capabilities.vision).toBe(true);
      expect(model.capabilities.effort).toEqual({ supported: true,
        low: { supported: true }, medium: { supported: true }, high: { supported: true },
        xhigh: { supported: true }, max: { supported: true },
      });
    }
  });
  it("does not resurrect unavailable or disabled models", () => {
    expect(studioModelCatalog(models.filter(m => m.id === "cc/claude-opus-5-5")).map(m => m.id)).toEqual(["cc/claude-opus-5-5"]);
    expect(studioModelCatalog([])).toEqual([]);
  });
  it("retains explicit Codex speed alias routing independently of discovery", () => {
    expect(resolveControls("codex", "gpt-6-astra@ultrafast(max)", {})).toMatchObject({ tier: "ultrafast", effort: "max" });
  });
  it("routes canonical Studio IDs to the account pool while respecting explicit operator aliases", async () => {
    vi.stubEnv("STUDIO_CURATED_CATALOG", "1");
    try {
      expect(await getModelInfoCore("claude-opus-5-5", {})).toEqual({ provider: "claude", model: "claude-opus-5-5" });
      expect(await getModelInfoCore("claude-fable-5-1", {})).toEqual({ provider: "claude", model: "claude-fable-5-1" });
      expect(await getModelInfoCore("claude-opus-5-5", { "claude-opus-5-5": "anthropic/claude-opus-5-5" })).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
      vi.stubEnv("STUDIO_CURATED_CATALOG", "0");
      expect(await getModelInfoCore("claude-opus-5-5", {})).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    } finally { vi.unstubAllEnvs(); }
  });
});
