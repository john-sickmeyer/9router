import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";
import { HEADROOM_VERIFIED_MODE } from "../../open-sse/rtk/constants.js";

const original = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, amount: "100.00" })), null, 2);
const options = { enabled: true, verified: true, url: "http://127.0.0.1:8787", model: "gpt-4o" };
const digest = (text) => createHash("sha256").update(text).digest("hex");
afterEach(() => vi.unstubAllGlobals());

function reply(messages) {
  const output = messages.map((m) => ({ ...m, content: "verified test fixture" }));
  return { messages: output, lossless: true, verification: HEADROOM_VERIFIED_MODE,
    proofs: messages.map((m, i) => ({ original_sha256: digest(m.content), compressed_sha256: digest(output[i].content) })) };
}

function stub(transform = (value) => value) {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    expect(request.verification).toBe(HEADROOM_VERIFIED_MODE);
    expect(request.config).toBeUndefined();
    return new Response(JSON.stringify(transform(reply(request.messages))));
  }));
}

function responses() {
  return { instructions: original, tools: [{ type: "function", name: "ledger", parameters: {} }], input: [
    { role: "user", content: original },
    { type: "reasoning", id: "r1", encrypted_content: "unchanged" },
    { type: "function_call", id: "f1", call_id: "t1", name: "ledger", arguments: "{}" },
    { type: "function_call_output", id: "out1", call_id: "t1", output: original },
    { type: "custom_tool_call_output", call_id: "t2", output: original },
  ] };
}

describe("verified lossless bridge", () => {
  it("preserves all native Responses fields outside verified tool text", async () => {
    const body = responses();
    const expected = structuredClone(body);
    expected.input[3].output = expected.input[4].output = "verified test fixture";
    stub();
    expect(await compressWithHeadroom(body, { ...options, format: "openai-responses", compressUserMessages: true })).not.toBeNull();
    expect(body).toEqual(expected);
  });

  it.each([
    ["openai", { messages: [{ role: "system", content: original }, { role: "user", content: original },
      { role: "tool", tool_call_id: "t1", content: original }] }, (b) => b.messages[2], "content"],
    ["claude", { system: original, messages: [{ role: "user", content: [
      { type: "text", text: original }, { type: "tool_result", tool_use_id: "t1", is_error: false,
        content: [{ type: "text", text: original }, { type: "image", source: { data: "unchanged" } }] }] }] },
      (b) => b.messages[0].content[1].content[0], "text"],
    ["gemini", { contents: [{ role: "user", parts: [{ text: original }, { functionResponse: {
      id: "t1", name: "ledger", response: { output: original, metadata: "unchanged" } } }] }] },
      (b) => b.contents[0].parts[1].functionResponse.response, "output"],
    ["kiro", { conversationState: { currentMessage: { userInputMessage: { content: original,
      userInputMessageContext: { toolResults: [{ toolUseId: "t1", content: [{ text: original }] }] } } } } },
      (b) => b.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].content[0], "text"],
    ["commandcode", { params: { system: original, messages: [{ role: "user", content: [
      { type: "text", text: original }, { type: "tool-result", toolCallId: "t1", toolName: "ledger",
        output: { type: "text", value: original } }] }] } }, (b) => b.params.messages[0].content[1].output, "value"],
  ])("preserves native %s structure", async (format, fixture, target, key) => {
    const body = structuredClone(fixture);
    const expected = structuredClone(body);
    target(expected)[key] = "verified test fixture";
    stub();
    expect(await compressWithHeadroom(body, { ...options, format })).not.toBeNull();
    expect(body).toEqual(expected);
  });

  it.each([
    ["missing verification", (r) => ({ ...r, verification: undefined })],
    ["lossy flag", (r) => ({ ...r, lossless: false })],
    ["wrong original", (r) => { r.proofs[1].original_sha256 = "wrong"; return r; }],
    ["truncated content", (r) => { r.messages[1].content = "cut"; return r; }],
    ["missing message", (r) => { r.messages.pop(); return r; }],
    ["wrong ID", (r) => { r.messages[1].tool_call_id = "wrong"; return r; }],
    ["wrong role", (r) => { r.messages[1].role = "user"; return r; }],
  ])("keeps originals atomically on %s", async (_name, transform) => {
    const body = responses();
    const expected = structuredClone(body);
    stub(transform);
    expect(await compressWithHeadroom(body, { ...options, format: "openai-responses" })).toBeNull();
    expect(body).toEqual(expected);
  });

  it.each(["timeout", "unavailable", "invalid JSON"])("keeps originals on %s", async (reason) => {
    const body = responses();
    const expected = structuredClone(body);
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (reason === "invalid JSON") return new Response("{");
      throw new Error(reason);
    }));
    expect(await compressWithHeadroom(body, { ...options, format: "openai-responses" })).toBeNull();
    expect(body).toEqual(expected);
  });

  it("never sends user/system-only requests or plain tool prose", async () => {
    vi.stubGlobal("fetch", vi.fn());
    for (const format of ["openai", "claude", "openai-responses"]) {
      const body = { messages: [{ role: "user", content: original }, { role: "tool", content: "do not delete\n".repeat(300) }],
        input: [{ role: "user", content: original }] };
      const expected = structuredClone(body);
      expect(await compressWithHeadroom(body, { ...options, format })).toBeNull();
      expect(body).toEqual(expected);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a stalled proxy at the configured timeout without changing the body", async () => {
    const body = responses();
    const expected = structuredClone(body);
    vi.stubGlobal("fetch", vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    expect(await compressWithHeadroom(body, { ...options, format: "openai-responses", timeoutMs: 10 })).toBeNull();
    expect(body).toEqual(expected);
  });

  it("never falls back to whole-message compression for a malformed native shape", async () => {
    const body = { messages: [{ role: "user", content: original }] };
    const expected = structuredClone(body);
    vi.stubGlobal("fetch", vi.fn());
    expect(await compressWithHeadroom(body, { ...options, format: "gemini" })).toBeNull();
    expect(body).toEqual(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.runIf(process.env.HEADROOM_TEST_URL)("verifies the live adapter through the native bridge", async () => {
    const body = responses();
    const expected = structuredClone(body);
    const result = await compressWithHeadroom(body, { ...options, url: process.env.HEADROOM_TEST_URL, format: "openai-responses" });
    expect(result?.verification).toBe(HEADROOM_VERIFIED_MODE);
    expect(result.tokens_saved).toBeGreaterThan(0);
    expect(body.input[3].output).toMatch(/^Lossless JSON table:/);
    expected.input[3].output = body.input[3].output;
    expected.input[4].output = body.input[4].output;
    expect(body).toEqual(expected);
  });
});
