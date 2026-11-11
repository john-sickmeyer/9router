import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", async original => ({ ...await original(), proxyAwareFetch: network.fetch }));
const model = "claude-fable-5-2";
const lock = `modelLock_${model}`;
const future = "2099-01-01T00:00:00.000Z";
const later = "2099-01-02T00:00:00.000Z";
const originalDataDir = process.env.DATA_DIR;
const ids = [];
let dataDir, db, auth, usageRoute, resetRoute;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-claude-quota-"));
  process.env.DATA_DIR = dataDir;
  db = await import("@/lib/localDb");
  auth = await import("@/sse/services/auth.js");
  usageRoute = await import("../../src/app/api/usage/[connectionId]/route.js");
  resetRoute = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
});
afterEach(async () => {
  vi.useRealTimers();
  for (const id of ids.splice(0)) await db.deleteProviderConnection(id);
  network.fetch.mockReset();
});
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function usage(fable = 0, weekly = 20, session) {
  return { seven_day: { utilization: weekly, resets_at: future },
    ...(session === undefined ? {} : { five_hour: { utilization: session, resets_at: later } }),
    limits: [{ kind: "weekly_scoped", percent: fable, resets_at: future, scope: { model: { display_name: "Fable" } } }] };
}
async function account(patch = {}) {
  const c = await db.createProviderConnection({ provider: "claude", authType: "oauth", name: crypto.randomUUID(),
    accessToken: crypto.randomUUID(), expiresAt: later });
  ids.push(c.id);
  return db.updateProviderConnection(c.id, { testStatus: "unavailable", errorCode: 502,
    lastError: "[502]: Unknown error", lastErrorAt: "2026-11-11T19:12:31Z", [lock]: future, ...patch });
}
const select = () => auth.getProviderCredentials("claude", null, model);
const refresh = c => usageRoute.GET(new Request(`http://localhost/api/usage/${c.id}?force=1`),
  { params: Promise.resolve({ connectionId: c.id }) });
const reset = c => resetRoute.POST(new Request(`http://localhost/api/usage/${c.id}/claude-reset`, {
  method: "POST", body: JSON.stringify({ grantId: "fixture_grant" }),
}), { params: Promise.resolve({ connectionId: c.id }) });

describe("Claude quota reset recovery", () => {
  it("restores legacy Fable locks even when another model overwrote the account error", async () => {
    const c = await account();
    network.fetch.mockImplementation(async () => Response.json(usage()));
    expect((await select()).connectionId).toBe(c.id);
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ [lock]: null, lastError: null });
    expect(network.fetch.mock.calls.every(([url, options]) => url.includes("/oauth/usage") && options.method === "GET")).toBe(true);
  });

  it("manual refresh bypasses exhausted cached usage after an external reset", async () => {
    const c = await account();
    network.fetch.mockImplementation(async () => Response.json(usage(100)));
    expect((await select()).allRateLimited).toBe(true);
    network.fetch.mockImplementation(async () => Response.json(usage()));
    expect((await refresh(c)).status).toBe(200);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBeNull();
  });

  it("a successful reset checks fresh usage and makes the account selectable immediately", async () => {
    const c = await account();
    network.fetch.mockImplementation(async () => Response.json(usage(100)));
    expect((await select()).allRateLimited).toBe(true);
    network.fetch.mockImplementation(async (url, options) => Response.json(options.method === "POST"
      ? { result: "reset" } : url.includes("/profile") ? { organization: { uuid: "org-fixture" } } : usage()));
    expect(await (await reset(c)).json()).toMatchObject({ ok: true });
    expect((await db.getProviderConnectionById(c.id))[lock]).toBeNull();
    expect((await select()).connectionId).toBe(c.id);
    expect(network.fetch.mock.calls.filter(([, opts]) => opts.method === "POST")).toHaveLength(1);
  });

  it("never clears a lock when the reset is refused or the subsequent usage read fails", async () => {
    const c = await account();
    network.fetch.mockImplementation(async (url, opts) => Response.json(opts.method === "POST"
      ? { result: "no_reset", reason: "not_eligible" } : { organization: { uuid: "org-fixture" } }));
    expect((await reset(c)).status).toBe(409);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
    network.fetch.mockImplementation(async (url, opts) => url.includes("/oauth/usage") || url.includes("/settings")
      ? new Response("unavailable", { status: 503 }) : Response.json(opts.method === "POST" ? { result: "reset" } : { organization: { uuid: "org-fixture" } }));
    expect(await (await reset(c)).json()).toMatchObject({ ok: true });
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });

  it("uses a post-reset read when a pre-reset quota check is already in flight", async () => {
    const c = await account();
    let releaseOldRead;
    let quotaReads = 0;
    network.fetch.mockImplementation(async (url, opts) => {
      if (url.includes("/oauth/usage")) {
        if (++quotaReads === 1) return new Promise(resolve => { releaseOldRead = () => resolve(Response.json(usage(100))); });
        return Response.json(usage());
      }
      if (opts.method === "POST") { releaseOldRead(); return Response.json({ result: "reset" }); }
      return Response.json({ organization: { uuid: "org-fixture" } });
    });
    const pending = select();
    await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf("function"));
    expect(await (await reset(c)).json()).toMatchObject({ ok: true });
    await pending;
    expect(quotaReads).toBe(2);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBeNull();
  });

  it("recognizes a recorded quota window even when a reset changes its reset time", async () => {
    const c = await account({ [lock]: null });
    await auth.markAccountUnavailable(c.id, 429, "Fable quota", "claude", model, Date.parse(future), { name: "weekly fable (7d)" });
    const fresh = usage();
    fresh.limits[0].resets_at = later;
    network.fetch.mockImplementation(async () => Response.json(fresh));
    expect((await select()).connectionId).toBe(c.id);
  });

  it("learns a legacy quota scope before a later reset changes the window timestamp", async () => {
    const c = await account();
    network.fetch.mockImplementation(async () => Response.json(usage(100)));
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[`claudeQuotaLock_${model}`])
      .toEqual({ expiry: future, window: "weekly fable (7d)" });
    const fresh = usage(); fresh.limits[0].resets_at = later;
    network.fetch.mockImplementation(async () => Response.json(fresh));
    expect((await refresh(c)).status).toBe(200);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBeNull();
  });

  it.each([-1, null, "0"])("does not infer recovery from malformed quota utilization %j", async percent => {
    const c = await account({ [lock]: null });
    await auth.markAccountUnavailable(c.id, 429, "Fable quota", "claude", model, Date.parse(future), { name: "weekly fable (7d)" });
    const raw = usage(); raw.limits[0].percent = percent;
    network.fetch.mockImplementation(async () => Response.json(raw));
    expect((await select()).allRateLimited).toBe(true);
  });

  it.each([usage(100), usage(0, 100), usage(0, 20, 100), {}, { limits: [] },
    { seven_day: { utilization: 0, resets_at: future } }])("keeps exhausted or unproven limits locked", async raw => {
    const c = await account();
    network.fetch.mockImplementation(async () => Response.json(raw));
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });

  it("recovers a recorded Fable limit while preserving an unrelated Opus authentication lock", async () => {
    const c = await account({ [lock]: null });
    await auth.markAccountUnavailable(c.id, 429, "Rate limit", "claude", model, Date.parse(future), { name: "weekly fable (7d)" });
    await auth.markAccountUnavailable(c.id, 403, "Forbidden", "claude", "claude-opus-5-5", Date.parse(later));
    network.fetch.mockImplementation(async () => Response.json(usage()));
    expect((await select()).connectionId).toBe(c.id);
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ [lock]: null, "modelLock_claude-opus-5-5": later, lastError: "Forbidden" });
  });

  it.each([401, 403, 502])("retains a recorded non-quota %s lock", async status => {
    const c = await account({ [lock]: null });
    await auth.markAccountUnavailable(c.id, status, "Not a quota failure", "claude", model, Date.parse(future));
    network.fetch.mockImplementation(async () => Response.json(usage()));
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });

  it("preserves a newer failure arriving during quota refresh", async () => {
    const c = await account();
    network.fetch.mockImplementation(async () => {
      await db.updateProviderConnection(c.id, { lastErrorAt: "2026-11-11T19:55:00Z", lastError: "New failure" });
      return Response.json(usage());
    });
    expect((await select()).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  });

  it("deduplicates concurrent and repeated checks without spending a reset", async () => {
    await account();
    network.fetch.mockImplementation(async () => Response.json(usage(100)));
    const results = await Promise.all([select(), select()]);
    expect(results.every(r => r.allRateLimited)).toBe(true);
    expect((await select()).allRateLimited).toBe(true);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(network.fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("recovers a recorded account-wide session lock only when that window is available", async () => {
    const c = await account({ [lock]: null });
    await auth.markAccountUnavailable(c.id, 429, "Session limit", "claude", null, Date.parse(later), { name: "session (5h)" });
    network.fetch.mockImplementation(async () => Response.json(usage(0, 20, 0)));
    expect((await select()).connectionId).toBe(c.id);
    expect((await db.getProviderConnectionById(c.id)).modelLock___all).toBeNull();
  });

  it("bounds stalled usage reads and leaves the account locked", async () => {
    const c = await account();
    network.fetch.mockImplementation(async () => new Promise(() => {}));
    const selected = select();
    expect((await selected).allRateLimited).toBe(true);
    expect((await db.getProviderConnectionById(c.id))[lock]).toBe(future);
  }, 7000);

  it("reports pool unavailability without attaching an unrelated old 502", async () => {
    await account();
    network.fetch.mockImplementation(async () => Response.json(usage(100)));
    const result = await select();
    expect(result.retryAfter).toBe(future);
    expect(result.lastError).toBe("All Claude accounts are at a usage limit or in cooldown for this model.");
    expect(result.lastError).not.toContain("502");
  });
});
