import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";

const usage = vi.hoisted(() => ({ value: null }));
vi.mock("../../open-sse/services/usage/claude.js", () => ({ getClaudeUsage: async () => usage.value }));

let db, auth, testSingleConnection, getClaudeQuotaBlock, parseUpstreamError, fallback, getConnectionHealth;
let dataDir;
const originalDataDir = process.env.DATA_DIR;
const future = "2099-01-01T00:00:00.000Z";
const later = "2099-01-02T00:00:00.000Z";

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-provider-health-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  db = await import("@/lib/localDb");
  auth = await import("@/sse/services/auth.js");
  ({ testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js"));
  ({ getClaudeQuotaBlock } = await import("@/sse/services/claudeQuota.js"));
  ({ parseUpstreamError } = await import("../../open-sse/utils/error.js"));
  fallback = await import("../../open-sse/services/accountFallback.js");
  ({ getConnectionHealth } = await import("@/shared/utils/connectionStatus.js"));
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});
beforeEach(() => { usage.value = null; });

async function connection(provider = "claude") {
  return db.createProviderConnection({ provider, authType: "oauth", name: crypto.randomUUID(),
    accessToken: "fixture", expiresAt: future, testStatus: "active" });
}

describe("provider reset times", () => {
  it("persists OpenAI billing suspension across DB reloads and successful connection tests", async () => {
    const billing = await import("@/lib/studio/openaiBilling.js");
    const c = await connection("openai");
    await billing.blockOpenaiBilling(c.id, "credit_balance_exhausted");
    await db.updateProviderConnection(c.id, { testStatus: "active", lastError: null, errorCode: null, lastErrorAt: null });
    const saved = await db.getProviderConnectionById(c.id);
    expect(saved).toMatchObject({ testStatus: "unavailable", studioBillingState: { status: "blocked", code: "credit_balance_exhausted" } });
    expect(getConnectionHealth(saved)).toMatchObject({ status: "unavailable" });
    expect(billing.billingUnavailable(saved)).toBe(true);
    await billing.reopenOpenaiBilling(c.id);
    const retry = await db.getProviderConnectionById(c.id);
    expect(retry.studioBillingState.status).toBe("retry");
    await auth.clearAccountError(c.id, retry, "gpt-6.1-sol");
    expect((await db.getProviderConnectionById(c.id)).studioBillingState).toBeNull();
  });

  it("does not let an earlier successful request clear a newer billing suspension", async () => {
    const billing = await import("@/lib/studio/openaiBilling.js");
    const c = await connection("openai");
    await billing.blockOpenaiBilling(c.id, "project_spend_limit_exceeded");
    await auth.clearAccountError(c.id, c, "gpt-6.1-sol");
    expect((await db.getProviderConnectionById(c.id)).studioBillingState.status).toBe("blocked");
  });
  it.each([null, { parseError: response => ({ status: response.status, message: "limit" }) }])
  ("honors Retry-After even with an executor parser (%j)", async executor => {
    const before = Date.now();
    const result = await parseUpstreamError(new Response("limited", { status: 429, headers: { "retry-after": "3600" } }), executor);
    expect(result.resetsAtMs).toBeGreaterThanOrEqual(before + 3600000);
    expect(result.resetsAtMs).toBeLessThanOrEqual(Date.now() + 3600000);
  });
  it("supports HTTP dates and preserves the later provider body reset", async () => {
    const response = () => new Response("limit", { status: 429, headers: { "retry-after": new Date(future).toUTCString() } });
    expect((await parseUpstreamError(response())).resetsAtMs).toBe(Date.parse(future));
    expect((await parseUpstreamError(response(), { parseError: () => ({ resetsAtMs: Date.parse(later) }) })).resetsAtMs).toBe(Date.parse(later));
  });
  it.each(["garbage", "-10", "0", "Infinity", "Mon, 01 Jan 2001 00:00:00 GMT"])("ignores invalid or elapsed Retry-After %s", async value => {
    expect((await parseUpstreamError(new Response("limit", { status: 429, headers: { "retry-after": value } }))).resetsAtMs).toBeUndefined();
  });
  it("keeps a weekly reset instead of clipping it to 30 minutes", async () => {
    const c = await connection("codex");
    await auth.markAccountUnavailable(c.id, 429, "quota exhausted", "codex", "test-model", Date.parse(future));
    expect((await db.getProviderConnectionById(c.id))["modelLock_test-model"]).toBe(future);
  });
});

describe("Claude quota scope", () => {
  const quota = (resetAt, remainingPercentage = 0) => ({ resetAt, remainingPercentage });
  it("waits for both exhausted session and weekly windows", () => {
    expect(getClaudeQuotaBlock({ quotas: { "session (5h)": quota(future), "weekly (7d)": quota(later) } }, "claude-opus-5-5"))
      .toMatchObject({ accountWide: true, resetsAtMs: Date.parse(later) });
  });
  it("never blocks Opus for a Fable-only limit", () => {
    const data = { quotas: { "weekly fable (7d)": quota(future) } };
    expect(getClaudeQuotaBlock(data, "claude-opus-5-5")).toBeNull();
    expect(getClaudeQuotaBlock(data, "claude-fable-5-1")).toMatchObject({ accountWide: false });
    expect(getClaudeQuotaBlock(data)).toBeNull();
  });
  it("does not turn missing, invalid or recovered usage into a lock", () => {
    expect(getClaudeQuotaBlock({ message: "usage unavailable" })).toBeNull();
    expect(getClaudeQuotaBlock({ quotas: { "weekly (7d)": quota(future, 1), "session (5h)": quota("invalid") } })).toBeNull();
  });
  it("does not treat a spent included allowance as exhausted paid extra usage", () => {
    expect(getClaudeQuotaBlock({ extraUsage: { is_enabled: true, used_credits: 1, monthly_limit: 100 },
      quotas: { "weekly (7d)": quota(future) } })).toBeNull();
  });
});

describe("persistent connection health", () => {
  it("connection testing retains a known 429 lock and returns a warning", async () => {
    const c = await connection();
    await db.updateProviderConnection(c.id, { testStatus: "unavailable", errorCode: 429,
      lastError: "Weekly limit reached", lastErrorAt: "2026-10-29T12:00:00Z", modelLock___all: future });
    const result = await testSingleConnection(c.id);
    expect(result).toMatchObject({ valid: true, retryAfter: future });
    expect(result.warning).toContain("Credentials valid");
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ testStatus: "unavailable", errorCode: 429, modelLock___all: future });
  });
  it("a test discovers weekly exhaustion even when the token is valid", async () => {
    const c = await connection();
    usage.value = { quotas: { "weekly (7d)": { remainingPercentage: 0, resetAt: future } } };
    expect(await testSingleConnection(c.id)).toMatchObject({ valid: true, retryAfter: future });
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ testStatus: "unavailable", errorCode: 429, modelLock___all: future });
  });
  it("an expired model lock cannot mask an active account-wide lock", () => {
    const c = { modelLock_test: "2000-01-01T00:00:00Z", modelLock___all: future };
    expect(fallback.isModelLockActive(c, "test")).toBe(true);
    expect(fallback.getModelLockUntil(c, "test")).toBe(future);
  });
  it("a success from before a concurrent 429 cannot clear the newer failure", async () => {
    const c = await connection();
    await db.updateProviderConnection(c.id, { testStatus: "unavailable", errorCode: 429,
      lastErrorAt: "2026-10-29T12:00:01Z", modelLock_test: future });
    await auth.clearAccountError(c.id, c, "test");
    expect((await db.getProviderConnectionById(c.id)).modelLock_test).toBe(future);
  });
  it("successful recovery of one model leaves another model's cooldown intact", async () => {
    const c = await connection();
    const current = await db.updateProviderConnection(c.id, { testStatus: "unavailable", errorCode: 429,
      lastError: "limited", modelLock_first: future, modelLock_second: later });
    await auth.clearAccountError(c.id, current, "first");
    expect(await db.getProviderConnectionById(c.id)).toMatchObject({ modelLock_first: null, modelLock_second: later, testStatus: "unavailable" });
  });
  it("the dashboard reports retry readiness separately from successful recovery", () => {
    expect(getConnectionHealth({ testStatus: "unavailable", errorCode: 429, modelLock_test: future }, Date.parse(future) + 1))
      .toEqual({ status: "retry ready", retryAfter: null });
    expect(getConnectionHealth({ testStatus: "active", errorCode: 429, modelLock_test: future, modelLock___all: later }))
      .toEqual({ status: "rate limited", retryAfter: later });
  });
});
