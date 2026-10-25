import { describe, it, expect, vi } from "vitest";
import { observeControlResponse } from "../../open-sse/services/controlResponse.js";
const controls = { provider: "codex", tier: "ultrafast", effort: "max" };
const event = (type, body = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...body })}\r\n\r\n`;
const done = (tier = "ultrafast", effort = "max") => event("response.completed", { response: { status: "completed", service_tier: tier, reasoning: { effort } } });
function stream(text, width = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += width) c.enqueue(bytes.slice(i, i + width)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
describe("Provider confirmation", () => {
  it.each([null, "application/json", "text/plain"])("recognizes forced Codex SSE with content-type %s", async contentType => {
    const response = stream(done());
    if (contentType) response.headers.set("content-type", contentType);
    else response.headers.delete("content-type");
    const observed = await observeControlResponse(response, controls);
    expect(await observed.text()).toContain("response.completed");
    expect(observed.headers.get("content-type")).toBe("text/event-stream");
  });
  it("preserves tool arguments across chunk/UTF-8 boundaries and verifies completion", async () => {
    const audit = vi.fn();
    const tool = event("response.function_call_arguments.delta", { delta: '{"city":"東京"}' });
    const res = await observeControlResponse(stream(tool + done() + "data: [DONE]\n\n"), controls, audit);
    expect(await res.text()).toContain('{\\"city\\":\\"東京\\"}');
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ state: "completed", speedVerified: true, reportedEffort: "max" }));
  });
  it.each([done("priority"), done(null), done("ultrafast", "low"), "data: [DONE]\n\n", event("response.failed")])("refuses unconfirmed completion", async text => {
    const audit = vi.fn();
    const res = await observeControlResponse(stream(text), controls, audit);
    await expect(res.text()).rejects.toThrow();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }));
  });
  it("normalizes response.done and accepts EOF without a trailing separator", async () => {
    const text = event("response.done", { response: { status: "completed", service_tier: "ultrafast" } }).trimEnd();
    const res = await observeControlResponse(stream(text), controls);
    expect(await res.text()).toContain("response.completed");
  });
  it("checks Claude usage.speed before its terminal event", async () => {
    const text = event("message_start", { message: { usage: { speed: "fast" } } }) + event("message_stop");
    const audit = vi.fn();
    const res = await observeControlResponse(stream(text), { provider: "claude", tier: "priority" }, audit);
    await res.text();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ speedVerified: true }));
  });
  it("marks disconnects cancelled", async () => {
    const audit = vi.fn();
    const res = await observeControlResponse(stream(done()), controls, audit);
    await res.body.cancel();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ state: "cancelled" }));
  });
});
