import { afterEach, describe, expect, it, vi } from "vitest";

const savedEnv = { ...process.env };
function familyFailure() {
  const failures = [
    Object.assign(new Error("IPv4 connection attempt timed out"), { code: "ETIMEDOUT", syscall: "connect", address: "160.79.104.10", port: 443 }),
    Object.assign(new Error("IPv6 route unavailable"), { code: "EHOSTUNREACH", syscall: "connect", address: "2607:6bc0::10", port: 443 }),
  ];
  return Object.assign(new TypeError("fetch failed"), { cause: new AggregateError(failures, "All connection attempts failed") });
}

async function setup(error) {
  vi.resetModules();
  process.env = { ...savedEnv };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
  const fetch = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(new Response('{"quotas":{}}'));
  const agents = [];
  class Agent {
    constructor(options) { this.options = options; agents.push(this); }
  }
  vi.doMock("undici", () => ({ fetch, Agent, ProxyAgent: Agent }));
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  return { fetch, agents, proxyAwareFetch };
}

afterEach(() => {
  process.env = { ...savedEnv };
  vi.doUnmock("undici");
});

describe("Studio quota requests with an unreachable IPv6 route", () => {
  it("retries a safe read on IPv4 after the raced IPv4 timeout and IPv6 route failure", async () => {
    const { fetch, agents, proxyAwareFetch } = await setup(familyFailure());
    const signal = new AbortController().signal;
    const headers = { Authorization: "Bearer fixture" };
    const response = await proxyAwareFetch("https://api.anthropic.com/api/oauth/usage", { method: "GET", headers, signal });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(agents[0].options.connect.autoSelectFamily).toBe(true);
    expect(agents[1].options.connect).toMatchObject({ family: 4, autoSelectFamily: false });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "GET", headers, signal });
  });

  it("does not retry inference POST requests", async () => {
    const error = familyFailure();
    const { fetch, proxyAwareFetch } = await setup(error);
    await expect(proxyAwareFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry through a different path when a proxy is in use", async () => {
    const error = familyFailure();
    const { fetch, proxyAwareFetch } = await setup(error);
    await expect(proxyAwareFetch("https://api.anthropic.com/api/oauth/usage", { method: "GET" }, { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8888", strictProxy: true })).rejects.toThrow("Proxy required but failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous fetch failure or an aborted read", async () => {
    const error = new TypeError("fetch failed");
    let test = await setup(error);
    await expect(test.proxyAwareFetch("https://api.anthropic.com/api/oauth/usage")).rejects.toBe(error);
    expect(test.fetch).toHaveBeenCalledTimes(1);
    test = await setup(familyFailure());
    const signal = AbortSignal.abort();
    await expect(test.proxyAwareFetch("https://api.anthropic.com/api/oauth/usage", { signal })).rejects.toThrow("fetch failed");
    expect(test.fetch).toHaveBeenCalledTimes(1);
  });

  it("makes only one IPv4 retry if that retry also fails", async () => {
    const error = familyFailure();
    const { fetch, proxyAwareFetch } = await setup(error);
    fetch.mockReset().mockRejectedValue(error);
    await expect(proxyAwareFetch("https://api.anthropic.com/api/oauth/usage")).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
