import { describe, expect, it, vi } from "vitest";
const fx = vi.hoisted(() => ({ refreshApi: vi.fn(async () => []), accounts: [
  { id: "missing", provider: "codex", isActive: true },
  { id: "old", provider: "codex", isActive: true, providerSpecificData: { studioCapabilities: {
    checkedAt: "2000-01-01T00:00:00Z", plan: "pro", models: { "gpt-6-astra": { tiers: ["priority"], efforts: [] } },
  } } },
  { id: "disabled", provider: "codex", isActive: false },
] }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: async () => fx.accounts, getOpenaiCreditBalance: async () => null }));
vi.mock("@/lib/studio/capabilities", () => ({ refreshOpenaiControlCapabilities: fx.refreshApi }));
vi.mock("@/lib/studio/audit", () => ({ controlStatus: async () => ({ pending: [], recent: [] }) }));
const route = await import("../../src/app/api/studio/route.js");

describe("Studio Codex speed presentation", () => {
  it("shows all speeds without consulting account plan or cached capabilities", async () => {
    const state = await (await route.GET()).json();
    expect(state.choices.length).toBeGreaterThan(0);
    for (const choice of state.choices) expect(choice.speeds).toEqual(["standard", "fast", "ultrafast"]);
    expect(state.accounts.map(a => a.id)).toEqual(["missing", "old"]);
    for (const account of state.accounts) {
      expect(account.speeds).toEqual(["standard", "fast", "ultrafast"]);
      expect(account).not.toHaveProperty("stale");
      expect(account).not.toHaveProperty("ultrafast");
    }
  });
  it("manual refresh only updates the separate OpenAI API model catalog", async () => {
    expect(await (await route.POST()).json()).toEqual({ results: [] });
    expect(fx.refreshApi).toHaveBeenCalledWith({ force: true });
  });
});
