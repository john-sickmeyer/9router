import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { calculateCostFromTokens, MODEL_PRICING } from "../../open-sse/providers/pricing.js";

describe("OpenAI metered pricing", () => {
  it.each([["default", 1], ["priority", 2], ["fast", 2], ["ultrafast", 6]])
  ("prices %s and counts reasoning only once", (serviceTier, multiplier) => {
    const tokens = { prompt_tokens: 12000, cached_tokens: 4000, cache_creation_input_tokens: 7000,
      cache_creation_12h_tokens: 4000, completion_tokens: 1200, reasoning_tokens: 777 };
    const expected = (1000 * 2 + 4000 * 0.1 + 3000 * 2.5 + 4000 * 5 + 1200 * 10) / 1e6;
    expect(calculateCostFromTokens(tokens, MODEL_PRICING["gpt-6.1-sol"], {
      provider: "openai", model: "gpt-6.1-sol", serviceTier,
    })).toBeCloseTo(expected * multiplier, 12);
  });
  it("applies the long-context threshold to the whole request", () => {
    const cost = n => calculateCostFromTokens({ prompt_tokens: n, completion_tokens: 1000 },
      MODEL_PRICING["gpt-6-astra"], { provider: "openai", model: "gpt-6-astra", serviceTier: "default" });
    expect(cost(272000)).toBeCloseTo((272000 * 10 + 1000 * 50) / 1e6, 12);
    expect(cost(272001)).toBeCloseTo((272001 * 20 + 1000 * 75) / 1e6, 12);
  });
});

let db, route, auth, adapter, directory;
const oldData = process.env.DATA_DIR;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-openai-credits-"));
  process.env.DATA_DIR = directory;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  route = await import("../../src/app/api/studio/openai-pool/route.js");
  auth = await import("@/sse/services/auth.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});
afterAll(() => {
  if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData;
  fs.rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  adapter.run("DELETE FROM _meta WHERE key = 'studioOpenaiCredits'");
  adapter.run("DELETE FROM providerConnections");
});
const setBalance = body => route.POST(new Request("http://localhost/api/studio/openai-pool", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set-credit-balance", ...body }),
}));
const readBalance = async () => (await (await route.GET()).json()).credit;

describe("credit checkpoint through real API, usage database and credential selection", () => {
  it("saves a paused account checkpoint without enabling API routing", async () => {
    const api = await db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "fixture", isActive: false });
    expect((await setBalance({ balanceUsd: 113.09, connectionIds: [api.id] })).status).toBe(200);
    expect((await readBalance()).remainingUsd).toBe(113.09);
    expect((await db.getProviderConnectionById(api.id)).isActive).toBe(false);
    expect(await auth.getProviderCredentials("openai")).toBeNull();
  });
  it("deducts only scoped API costs once, persists them and switches to OAuth at zero", async () => {
    const api = await db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "fixture", name: "API" });
    const oauth = await db.createProviderConnection({ provider: "codex", authType: "oauth", accessToken: "fixture", name: "OAuth" });
    const response = await setBalance({ balanceUsd: 0.01, connectionIds: [api.id] });
    expect(response.status, await response.text()).toBe(200);
    expect((await auth.getProviderCredentials("openai")).connectionId).toBe(api.id);
    const usage = { provider: "openai", model: "gpt-6.1-sol", connectionId: api.id,
      timestamp: "2026-10-30T19:00:00.000Z", tokens: { prompt_tokens: 1000, completion_tokens: 0 },
      billingContext: { serviceTier: "ultrafast", serviceTierSource: "reported" } };
    await db.saveRequestUsage({ ...usage, provider: "codex", connectionId: oauth.id });
    await db.saveRequestUsage({ ...usage, connectionId: "different-organization" });
    expect((await readBalance()).spentUsd).toBe(0);
    await db.saveRequestUsage({ ...usage });
    await db.saveRequestUsage({ ...usage });
    const credit = await readBalance();
    expect(credit.spentUsd).toBeCloseTo(0.012, 12);
    expect(credit.remainingUsd).toBe(0);
    expect(credit.exhausted).toBe(true);
    expect(JSON.parse(adapter.get("SELECT value FROM _meta WHERE key = 'studioOpenaiCredits'").value).spentUsd).toBeCloseTo(0.012, 12);
    expect(await auth.getProviderCredentials("openai")).toMatchObject({ billingBlocked: true });
    expect((await auth.getProviderCredentials("codex")).connectionId).toBe(oauth.id);
    // Updating a known balance resumes routing without a separate Retry API action.
    expect((await setBalance({ balanceUsd: 10, connectionIds: [api.id] })).status).toBe(200);
    expect((await auth.getProviderCredentials("openai")).connectionId).toBe(api.id);
  });
  it("rejects invalid checkpoints without changing an existing balance", async () => {
    const api = await db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "fixture" });
    expect((await setBalance({ balanceUsd: 274.36, connectionIds: [api.id] })).status).toBe(200);
    for (const body of [{ balanceUsd: -1 }, { balanceUsd: "12" }, { balanceUsd: 1, connectionIds: ["unknown"] }]) {
      expect((await setBalance({ connectionIds: [api.id], ...body })).status).toBe(400);
    }
    expect((await readBalance()).balanceUsd).toBe(274.36);
  });
});
