import { beforeEach, describe, it, expect, vi } from "vitest";
const network = vi.hoisted(() => ({ requests: [] }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: async (_url, request) => {
  network.requests.push(request);
  return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
} }));
import { CodexExecutor } from "../../open-sse/executors/codex.js";
beforeEach(() => { network.requests = []; });
describe("Codex outbound routing", () => {
  it.each([["default", undefined], ["fast", "priority"], ["ultrafast", "ultrafast"]])("keeps %s routing consistent after header overrides", async (requested, sent) => {
    const executor = new CodexExecutor();
    await executor.execute({ model: "gpt-6-astra", body: { input: "hi", reasoning: { effort: "max" }, service_tier: requested }, stream: true,
      credentials: { accessToken: "fixture", connectionId: "fixture" },
      providerOverrides: { headers: { "X-Codex-Routing-Hint": "model=wrong;tier=wrong" } } });
    expect(network.requests).toHaveLength(1);
    const request = network.requests[0];
    const body = JSON.parse(request.body);
    expect(body.service_tier).toBe(sent);
    expect(body.reasoning.effort).toBe("max");
    const hints = Object.entries(request.headers).filter(([name]) => name.toLowerCase() === "x-codex-routing-hint");
    expect(hints).toEqual([["x-codex-routing-hint", `model=gpt-6-astra${sent ? `;tier=${sent}` : ""}`]]);
  });
});
