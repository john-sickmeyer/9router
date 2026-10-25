import { beforeEach, describe, it, expect, vi } from "vitest";
const db = vi.hoisted(() => ({ getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(), getSettings: vi.fn(async () => ({})), getProxyPools: vi.fn(), validateApiKey: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");
const model = "gpt-6-astra";
const requestControls = { provider: "codex", model, tier: "ultrafast", effort: "max" };
const account = (id, tiers) => ({ id, provider: "codex", isActive: true, providerSpecificData: { studioCapabilities: { checkedAt: new Date().toISOString(), models: { [model]: { tiers, efforts: ["max"] } } } } });
let accounts;
beforeEach(() => {
  accounts = [account("pro", ["priority"]), account("max1", ["ultrafast"]), account("max2", ["ultrafast"])];
  db.getProviderConnections.mockImplementation(async () => accounts);
  db.updateProviderConnection.mockImplementation(async (id, update) => Object.assign(accounts.find(c => c.id === id), update));
});
describe("eligible account rotation", () => {
  it("switches after a real quota lock, retains controls and never chooses a Pro-only account", async () => {
    const first = await getProviderCredentials("codex", null, model, { requestControls });
    expect(first.connectionId).toBe("max1");
    expect((await markAccountUnavailable(first.connectionId, 429, "Rate limit reached", "codex", model)).shouldFallback).toBe(true);
    const second = await getProviderCredentials("codex", new Set([first.connectionId]), model, { requestControls });
    expect(second.connectionId).toBe("max2");
    await markAccountUnavailable(second.connectionId, 429, "Rate limit reached", "codex", model);
    const exhausted = await getProviderCredentials("codex", new Set([first.connectionId, second.connectionId]), model, { requestControls });
    expect(exhausted.allRateLimited).toBe(true);
    expect(requestControls).toEqual({ provider: "codex", model, tier: "ultrafast", effort: "max" });
  });
  it("returns an explicit eligibility failure when only Pro accounts remain", async () => {
    accounts = accounts.slice(0, 1);
    expect(await getProviderCredentials("codex", null, model, { requestControls })).toEqual({ noEligibleControls: true });
  });
});
