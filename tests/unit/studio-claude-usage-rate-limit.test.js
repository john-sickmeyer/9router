import { afterEach, describe, expect, it, vi } from "vitest";

async function setup() {
  vi.resetModules();
  const fetch = vi.fn();
  vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetch }));
  const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T14:00:00Z"));
  return { fetch, getClaudeUsage };
}
afterEach(() => { vi.useRealTimers(); vi.doUnmock("../../open-sse/utils/proxyFetch.js"); });

describe("Claude usage rate limit reporting", () => {
  it("honors provider Retry-After seconds without falling through to an admin-only API", async () => {
    const { fetch, getClaudeUsage } = await setup();
    fetch.mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "3321" } }));
    const first = await getClaudeUsage("fixture-token", null, { force: true });
    expect(first).toMatchObject({ retryAt: "2026-11-15T14:55:21.000Z" });
    expect(first.message).toMatch(/rate.limit/i);
    expect(first.message).not.toMatch(/admin|permissions/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(181000);
    const second = await getClaudeUsage("fixture-token", null, { force: true });
    expect(second.retryAt).toBe(first.retryAt);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3141000);
    fetch.mockResolvedValue(new Response(JSON.stringify({ seven_day: { utilization: 51, resets_at: null } }), { status: 200 }));
    expect((await getClaudeUsage("fixture-token", null, { force: true })).quotas["weekly (7d)"].used).toBe(51);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts an HTTP date Retry-After header", async () => {
    const { fetch, getClaudeUsage } = await setup();
    fetch.mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "Sun, 15 Nov 2026 14:10:00 GMT" } }));
    expect((await getClaudeUsage("date-token", null, { force: true })).retryAt).toBe("2026-11-15T14:10:00.000Z");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the existing cooldown when Retry-After is invalid", async () => {
    const { fetch, getClaudeUsage } = await setup();
    fetch.mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "invalid" } }));
    expect((await getClaudeUsage("invalid-token", null, { force: true })).retryAt).toBe("2026-11-15T14:03:00.000Z");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces expired OAuth authentication so the existing route can refresh it", async () => {
    const { fetch, getClaudeUsage } = await setup();
    fetch.mockResolvedValue(new Response("{}", { status: 401 }));
    const result = await getClaudeUsage("expired-token", null, { force: true });
    expect(result.message).toMatch(/authentication.*expired/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
