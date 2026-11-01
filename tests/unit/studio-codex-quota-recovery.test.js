import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getConnectionHealth } from "@/shared/utils/connectionStatus.js";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
// The provider HTTP boundary is synthetic; parsing, selection and SQLite are real.
vi.mock("../../open-sse/utils/proxyFetch.js", async importOriginal => ({
  ...await importOriginal(), proxyAwareFetch: network.fetch,
}));

const model = "gpt-6.1-sol";
const requestControls = { provider: "codex", model, tier: "ultrafast", effort: "max" };
const lock = `modelLock_${model}@ultrafast`;
const future = "2099-01-01T00:00:00.000Z";
const originalDataDir = process.env.DATA_DIR;
const ids = [];
let dataDir, db, auth, usageRoute, resetRoute;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-codex-quota-"));
  process.env.DATA_DIR = dataDir;
  db = await import("@/lib/localDb");
  auth = await import("@/sse/services/auth.js");
  usageRoute = await import("../../src/app/api/usage/[connectionId]/route.js");
  resetRoute = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
});
afterEach(async () => {
  for (const id of ids.splice(0)) await db.deleteProviderConnection(id);
  network.fetch.mockReset();
});
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function providerUsage(allowed = true) {
  return { plan_type: "promax", rate_limit: {
    allowed, limit_reached: !allowed,
    primary_window: { used_percent: allowed ? 0 : 100, reset_at: 4070908800 },
    secondary_window: null,
  } };
}

async function connection(overrides = {}) {
  const c = await db.createProviderConnection({ provider: "codex", authType: "oauth",
    name: crypto.randomUUID(), accessToken: crypto.randomUUID(), expiresAt: future,
    providerSpecificData: { chatgptAccountId: "fixture-account" },
  });
  ids.push(c.id);
  return db.updateProviderConnection(c.id, { testStatus: "unavailable", errorCode: 429,
    lastError: "[429]: The usage limit has been reached", lastErrorAt: "2026-10-30T12:00:00.000Z",
    [lock]: future, ...overrides });
}

const select = () => auth.getProviderCredentials("codex", null, model, { requestControls });

describe("Codex quota recovery", () => {
  it("rechecks locked credentials and selects restored quota while retaining exhausted accounts", async () => {
    const restored = await connection();
    const exhausted = await connection();
    network.fetch.mockImplementation(async (_url, options) => Response.json(providerUsage(
      options.headers.Authorization === `Bearer ${restored.accessToken}`,
    )));

    expect((await select()).connectionId).toBe(restored.id);
    expect(await db.getProviderConnectionById(restored.id)).toMatchObject({ [lock]: null, lastError: null });
    expect(getConnectionHealth(await db.getProviderConnectionById(restored.id)).status).toBe("retry ready");
    expect((await db.getProviderConnectionById(exhausted.id))[lock]).toBe(future);
    expect(network.fetch.mock.calls.every(([url]) => url.endsWith("/wham/usage"))).toBe(true);
    expect(network.fetch.mock.calls[0][1].headers["ChatGPT-Account-ID"]).toBe("fixture-account");
  });

  it("manual usage refresh recovers persisted locks after an external reset", async () => {
    const c = await connection();
    network.fetch.mockImplementation(async () => Response.json(providerUsage(false)));
    expect((await select()).allRateLimited).toBe(true);
    network.fetch.mockImplementation(async () => Response.json(providerUsage()));
    const response = await usageRoute.GET(new Request(`http://localhost/api/usage/${c.id}?force=1`),
      { params: Promise.resolve({ connectionId: c.id }) });
    expect(response.status).toBe(200);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBeNull();
  });

  it("a successful reset-credit operation confirms usage and reconciles the lock immediately", async () => {
    const c = await connection();
    network.fetch.mockImplementation(async url => Response.json(url.endsWith("/consume")
      ? { code: "reset", windows_reset: 1 } : providerUsage()));
    const response = await resetRoute.POST(new Request(`http://localhost/api/usage/${c.id}/codex-reset-credits`, { method: "POST" }),
      { params: Promise.resolve({ connectionId: c.id }) });
    expect(await response.json()).toMatchObject({ reset: true, windows_reset: 1 });
    expect((await db.getProviderConnectionById(c.id))[lock]).toBeNull();
  });

  it.each([
    { plan_type: "promax" },
    { rate_limit: { allowed: true, limit_reached: false, primary_window: { reset_at: 4070908800 } } },
    { ...providerUsage(), additional_rate_limits: [{ limit_name: "ultrafast", rate_limit: { allowed: false } }] },
    { rate_limit: { ...providerUsage().rate_limit, secondary_window: { used_percent: 100, reset_at: 4070908800 } } },
    providerUsage(false),
  ])("retains locks when quota evidence is missing, malformed or exhausted", async body => {
    const c = await connection();
    network.fetch.mockImplementation(async () => Response.json(body));
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });

  it("does not confuse accelerated capacity or authentication failures with quota exhaustion", async () => {
    const capacity = await connection({ lastError: "Fast capacity limit" });
    const authentication = await connection({ errorCode: 401, lastError: "Unauthorized" });
    network.fetch.mockImplementation(async () => Response.json(providerUsage()));
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(capacity.id))[lock]).toBe(future);
    expect((await db.getProviderConnectionById(authentication.id))[lock]).toBe(future);
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("leaves an unrelated model and tier lock intact when the known quota lock recovers", async () => {
    const c = await connection({ [lock]: null });
    await auth.markAccountUnavailable(c.id, 429, "The usage limit has been reached", "codex", `${model}@ultrafast`, Date.parse(future));
    await auth.markAccountUnavailable(c.id, 429, "Fast capacity limit", "codex", `${model}@priority`, Date.parse(future));
    await auth.markAccountUnavailable(c.id, 403, "Model unavailable", "codex", "gpt-6-astra", Date.parse(future));
    network.fetch.mockImplementation(async () => Response.json(providerUsage()));
    expect((await select()).connectionId).toBe(c.id);
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ [lock]: null,
      [`modelLock_${model}@priority`]: future, "modelLock_gpt-6-astra": future, lastError: "Model unavailable" });
  });

  it("does not infer review quota recovery from an available normal allowance", async () => {
    const c = await connection({ [lock]: null });
    await auth.markAccountUnavailable(c.id, 429, "The usage limit has been reached", "codex", `${model}@ultrafast`, Date.parse(future));
    await auth.markAccountUnavailable(c.id, 429, "The usage limit has been reached", "codex", `${model}-review`, Date.parse(future));
    network.fetch.mockImplementation(async () => Response.json({ ...providerUsage(),
      code_review_rate_limit: providerUsage(false).rate_limit }));
    expect((await select()).connectionId).toBe(c.id);
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ [lock]: null,
      [`modelLock_${model}-review`]: future });
  });

  it("preserves a newer failure arriving during the quota lookup", async () => {
    const c = await connection();
    network.fetch.mockImplementation(async () => {
      await db.updateProviderConnection(c.id, { lastErrorAt: new Date().toISOString(), lastError: "New limit" });
      return Response.json(providerUsage());
    });
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });

  it("deduplicates repeated blocked retries and keeps failed usage lookups closed", async () => {
    const c = await connection();
    network.fetch.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    expect((await select()).allRateLimited).toBe(true);
    expect((await select()).allRateLimited).toBe(true);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });
});
