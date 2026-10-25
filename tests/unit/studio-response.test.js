import { describe, it, expect, vi } from "vitest";
import { observeControlResponse } from "../../open-sse/services/controlResponse.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
const controls = { provider: "codex", tier: "ultrafast", effort: "max" };
const event = (type, body = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...body })}\r\n\r\n`;
const done = (tier = "ultrafast", effort = "max") => event("response.completed", { response: { status: "completed", service_tier: tier, reasoning: { effort } } });
function stream(text, width = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += width) c.enqueue(bytes.slice(i, i + width)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
describe("Provider confirmation", () => {
  it("keeps provider metadata, final output, and detailed usage in JSON conversion", async () => {
    const output = [{ type: "message", content: [{ type: "output_text", text: "OK" }] }];
    const response = { id: "fixture", status: "completed", service_tier: "default", reasoning: { effort: "max" }, output, usage: { input_tokens: 12, output_tokens: 2, input_tokens_details: { cached_tokens: 6 } } };
    const res = stream(`data: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`);
    const json = await convertResponsesStreamToJson(res.body);
    expect(json).toMatchObject(response);
  });
  it("records ambiguous Codex default metadata without inventing confirmation or failing useful output", async () => {
    const audit = vi.fn();
    const res = await observeControlResponse(stream(done("default")), controls, audit);
    expect(await res.text()).toContain("response.completed");
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ state: "completed", speedVerified: false, reportedTier: "default", warning: expect.stringContaining("did not confirm") }));
  });
  it("still rejects an actual Claude fast downgrade", async () => {
    await expect(observeControlResponse(Response.json({ usage: { speed: "standard" } }), { provider: "claude", tier: "priority" })).rejects.toThrow();
  });
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
  it("keeps a verified completion when the native client closes its SSE reader", async () => {
    const audit = vi.fn();
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(done())); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    const res = await observeControlResponse(upstream, controls, audit);
    const reader = res.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.completed");
    await reader.cancel();
    await new Promise(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledOnce();
    expect(audit.mock.calls.map(([entry]) => entry.state)).toEqual(["completed"]);
  });
});
