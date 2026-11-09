import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real SQLite repositories and real Studio routes; only OpenAI's HTTP endpoint is synthetic.
const ADMIN = "sk-admin-FixtureAdminKeyValue0123456789abcdef";
const OTHER = "sk-admin-RejectedAdminKeyValue0123456789abcd";
const calls = [];
let costs = [];
const gate = { hold: null };
let db, poolRoute, studioRoute, providersRoute, providerRoute, auth, balances, directory;
const oldData = process.env.DATA_DIR;
const day = (iso, value) => ({ object: "bucket", start_time: Date.parse(`${iso}T00:00:00Z`) / 1000,
  end_time: Date.parse(`${iso}T00:00:00Z`) / 1000 + 86400, results: value ? [{ amount: { value, currency: "usd" }, line_item: "fixture" }] : [] });

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-openai-admin-"));
  process.env.DATA_DIR = directory;
  vi.stubEnv("STUDIO_OPENAI_POOL_ENABLED", "1");
  vi.resetModules();
  vi.doMock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(async (url, options, proxy) => {
    calls.push({ url, method: options.method, auth: options.headers.Authorization, redirect: options.redirect, strictTls: options.strictTls, proxy });
    const parsed = new URL(url);
    if (options.headers.Authorization !== `Bearer ${ADMIN}`) return Response.json({ error: { message: "bad key" } }, { status: 401 });
    if (parsed.pathname === "/v1/organization/projects") return Response.json({ object: "list", data: [{ id: "proj_fixture" }], has_more: false });
    if (parsed.pathname === "/v1/organization/projects/proj_fixture/api_keys") return Response.json({ object: "list",
      data: [{ id: "key_fixture", redacted_value: "sk-proj-********************************-jts.1" }], has_more: false });
    if (parsed.pathname === "/v1/organization/costs") {
      if (gate.hold) await gate.hold;
      const page = Number(parsed.searchParams.get("page") || 0);
      const from = Number(parsed.searchParams.get("start_time"));
      const data = (costs[page] || []).filter(b => b.start_time >= from);
      if (gate.noNextPage) return Response.json({ object: "page", data, has_more: true, next_page: null });
      return Response.json({ object: "page", data, has_more: page + 1 < costs.length, next_page: page + 1 < costs.length ? String(page + 1) : null });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) }));
  db = await import("@/lib/db/index.js");
  poolRoute = await import("../../src/app/api/studio/openai-pool/route.js");
  studioRoute = await import("../../src/app/api/studio/route.js");
  providersRoute = await import("../../src/app/api/providers/route.js");
  providerRoute = await import("../../src/app/api/providers/[id]/route.js");
  auth = await import("@/sse/services/auth.js");
  balances = await import("@/lib/studio/openaiAdminBalance.js");
});
afterAll(() => {
  vi.unstubAllEnvs();
  if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData;
  fs.rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  calls.length = 0;
  gate.hold = null;
  costs = [[day("2026-10-30", 250), day("2026-10-31", 0), day("2026-11-01", 599.8179)]];
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("DELETE FROM providerConnections");
  adapter.run("DELETE FROM usageHistory");
});
const act = body => poolRoute.POST(new Request("http://localhost/api/studio/openai-pool", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const api = (name = "jts.1", extra = {}) => db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: `sk-proj-inference-${name}`, name, ...extra });

describe("per-connection OpenAI admin keys and grant balances", () => {
  it("verifies the key with a read-only GET, stores it on the connection, and computes the balance", async () => {
    const conn = await api();
    let res = await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    expect(res.status, await res.clone().text()).toBe(200);
    res = await act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 500, grantedOn: "2026-10-31" }] });
    const view = (await res.json()).balances[conn.id];
    expect(view).toMatchObject({ configured: true, grantsUsd: 500, billedUsd: 599.8179, remainingUsd: -99.82, overdrawn: true, keyHint: "sk-admin-…cdef" });
    expect((await db.getProviderConnectionById(conn.id)).studioOpenaiAdmin.key).toBe(ADMIN);
    // Only GETs to the organization admin API, never inference endpoints, never redirects.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      // Direct to api.openai.com with certificate verification: no proxy pool, relay, or insecure-TLS retry.
      expect(call.strictTls).toBe(true);
      expect(call.proxy).toBeNull();
      expect(new URL(call.url).origin).toBe("https://api.openai.com");
      expect(new URL(call.url).pathname).toMatch(/^\/v1\/organization\/(projects|projects\/proj_[A-Za-z0-9]+\/api_keys|costs)$/);
    }
    // The cost window starts at UTC midnight of the earliest grant date (OpenAI's daily buckets).
    const costCall = calls.findLast(c => c.url.includes("/costs"));
    expect(Number(new URL(costCall.url).searchParams.get("start_time"))).toBe(Date.parse("2026-10-31T00:00:00Z") / 1000);
    expect(view.organizationMatch).toBe(true);
  });

  it("never returns the admin key from Studio or provider APIs", async () => {
    const conn = await api();
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    const bodies = [
      await (await studioRoute.GET()).text(),
      await (await act({ action: "refresh-balances" })).text(),
      await (await providersRoute.GET()).text(),
      await (await providerRoute.GET(new Request(`http://localhost/api/providers/${conn.id}`), { params: Promise.resolve({ id: conn.id }) })).text(),
    ];
    for (const body of bodies) expect(body).not.toContain(ADMIN);
    expect(JSON.parse(bodies[2]).connections[0].studioOpenaiAdmin).toEqual({ configured: true, keyHint: "sk-admin-…cdef" });
  });

  it("rejects keys OpenAI refuses, the inference key, and malformed keys without saving", async () => {
    const conn = await api();
    for (const adminKey of [OTHER, "sk-proj-inference-jts.1", "not-a-key"]) {
      const res = await act({ action: "set-admin-key", connectionId: conn.id, adminKey });
      expect(res.status).toBe(400);
    }
    expect((await db.getProviderConnectionById(conn.id)).studioOpenaiAdmin).toBeUndefined();
    expect((await act({ action: "set-admin-key", connectionId: "missing", adminKey: ADMIN })).status).toBe(404);
    const codex = await db.createProviderConnection({ provider: "codex", authType: "oauth", accessToken: "fixture" });
    expect((await act({ action: "set-admin-key", connectionId: codex.id, adminKey: ADMIN })).status).toBe(404);
  });

  it("validates grants and requires an admin key first", async () => {
    const conn = await api();
    expect((await act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 5, grantedOn: "2026-10-31" }] })).status).toBe(400);
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    for (const grants of [[{ amountUsd: -1, grantedOn: "2026-10-31" }], [{ amountUsd: 5, grantedOn: "2026-02-30" }],
      [{ amountUsd: 5, grantedOn: "2026-10-31", expiresOn: "2026-10-01" }], "nope"]) {
      expect((await act({ action: "set-grants", connectionId: conn.id, grants })).status).toBe(400);
    }
  });

  it("does not change routing, billing blocks, or active state", async () => {
    const conn = await api("blocked", { isActive: true });
    await db.updateProviderConnection(conn.id, { studioBillingState: { status: "blocked", code: "insufficient_quota" } });
    const before = await db.getProviderConnectionById(conn.id);
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    await act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 1000, grantedOn: "2026-10-31" }] });
    const after = await db.getProviderConnectionById(conn.id);
    expect(after.studioBillingState).toEqual(before.studioBillingState);
    expect(after.isActive).toBe(true);
    expect(after.apiKey).toBe(before.apiKey);
    // A positive balance does not reopen a billing-blocked key; only OpenAI's own responses or Retry API do.
    expect(await auth.getProviderCredentials("openai")).toMatchObject({ billingBlocked: true });
  });

  it("follows pagination, records failures without losing the last good read, and reads paused accounts", async () => {
    const conn = await api("paused", { isActive: false });
    costs = [[day("2026-10-31", 100)], [day("2026-11-01", 50.5)]];
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    let view = (await (await act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 200, grantedOn: "2026-10-31" }] })).json()).balances[conn.id];
    expect(view).toMatchObject({ billedUsd: 150.5, remainingUsd: 49.5, overdrawn: false, readComplete: true });
    // Swap the stored key for one OpenAI rejects: the error is shown and the last read stays.
    const stored = (await db.getProviderConnectionById(conn.id)).studioOpenaiAdmin;
    await db.updateProviderConnection(conn.id, { studioOpenaiAdmin: { ...stored, key: OTHER } });
    view = (await (await act({ action: "refresh-balances", force: true })).json()).balances[conn.id];
    expect(view.billedUsd).toBe(150.5);
    expect(view.error.message).toMatch(/rejected/);
    const state = await (await studioRoute.GET()).json();
    expect(state.openaiPool.allAccounts.map(a => a.id)).toContain(conn.id);
    expect(state.openaiPool.balances[conn.id].configured).toBe(true);
  });

  it("compares with 9Router's own recorded cost for the same window and connection", async () => {
    const conn = await api();
    const other = await api("other");
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    await act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 500, grantedOn: "2026-10-31" }] });
    const usage = { provider: "openai", model: "gpt-6.1-sol", tokens: { prompt_tokens: 1000, completion_tokens: 0 },
      billingContext: { serviceTier: "default", serviceTierSource: "reported" } };
    await db.saveRequestUsage({ ...usage, connectionId: conn.id, timestamp: "2026-11-01T03:00:00.000Z" });
    await db.saveRequestUsage({ ...usage, connectionId: conn.id, timestamp: "2026-10-20T03:00:00.000Z" });
    await db.saveRequestUsage({ ...usage, connectionId: other.id, timestamp: "2026-11-01T03:00:00.000Z" });
    const view = (await (await studioRoute.GET()).json()).openaiPool.balances[conn.id];
    expect(view.local.requests).toBe(1);
    expect(view.local.costUsd).toBeGreaterThan(0);
  });

  it("status reads are cache-only and removal clears the key", async () => {
    const conn = await api();
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    calls.length = 0;
    await studioRoute.GET();
    expect(calls).toEqual([]);
    expect((await act({ action: "remove-admin-key", connectionId: conn.id })).status).toBe(200);
    expect((await db.getProviderConnectionById(conn.id)).studioOpenaiAdmin).toBeNull();
    expect((await (await studioRoute.GET()).json()).openaiPool.balances[conn.id]).toEqual({ configured: false });
  });

  it("an edit made while a refresh is in flight is never overwritten or answered with the stale read", async () => {
    const conn = await api();
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    let release;
    gate.hold = new Promise(resolve => { release = resolve; });
    const slow = act({ action: "refresh-balances", force: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    gate.hold = null;
    const edit = act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 700, grantedOn: "2026-11-01" }] });
    const editView = (await (await edit).json()).balances[conn.id];
    release();
    await slow;
    // The edit got its own fresh read for the new window, and the slow refresh did not replace it.
    expect(editView).toMatchObject({ grantsUsd: 700, billedUsd: 599.8179, remainingUsd: 100.18 });
    const stored = (await db.getProviderConnectionById(conn.id)).studioOpenaiAdmin;
    expect(stored.grants).toEqual([{ amountUsd: 700, grantedOn: "2026-11-01", expiresOn: null }]);
    expect(stored.lastRead.billedUsd).toBe(599.8179);
  });

  it("a removal during a refresh stays removed", async () => {
    const conn = await api();
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    let release;
    gate.hold = new Promise(resolve => { release = resolve; });
    const slow = act({ action: "refresh-balances", force: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await act({ action: "remove-admin-key", connectionId: conn.id })).status).toBe(200);
    release();
    await slow;
    expect((await db.getProviderConnectionById(conn.id)).studioOpenaiAdmin).toBeNull();
  });

  it("marks a read incomplete when OpenAI says more pages exist but gives no cursor", async () => {
    const conn = await api();
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    gate.noNextPage = true;
    try {
      const view = (await (await act({ action: "set-grants", connectionId: conn.id, grants: [{ amountUsd: 500, grantedOn: "2026-10-31" }] })).json()).balances[conn.id];
      expect(view.readComplete).toBe(false);
    } finally { gate.noNextPage = false; }
  });

  it("flags an admin key whose organization does not list this connection's API key, and later API-key changes", async () => {
    const conn = await api("someone-else");
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    let view = (await (await studioRoute.GET()).json()).openaiPool.balances[conn.id];
    expect(view).toMatchObject({ organizationMatch: false, inferenceKeyChanged: false });
    await db.updateProviderConnection(conn.id, { apiKey: "sk-proj-replacement-key-wxyz" });
    view = (await (await studioRoute.GET()).json()).openaiPool.balances[conn.id];
    expect(view.inferenceKeyChanged).toBe(true);
  });

  it("does not carry the admin key in inference credentials", async () => {
    const conn = await api();
    await act({ action: "set-admin-key", connectionId: conn.id, adminKey: ADMIN });
    const credentials = await auth.getProviderCredentials("openai");
    expect(credentials.connectionId).toBe(conn.id);
    expect(JSON.stringify(credentials)).not.toContain(ADMIN);
    expect(credentials._connection.studioOpenaiAdmin).toBeUndefined();
  });

  it("normalizes grants: rounds, sorts, and limits notes", () => {
    expect(balances.normalizeGrants([{ amountUsd: "25.005", grantedOn: "2026-11-02" }, { amountUsd: 500, grantedOn: "2026-10-31", note: "x".repeat(200) }]))
      .toEqual([{ amountUsd: 500, grantedOn: "2026-10-31", expiresOn: null, note: "x".repeat(120) }, { amountUsd: 25.01, grantedOn: "2026-11-02", expiresOn: null }]);
  });
});
