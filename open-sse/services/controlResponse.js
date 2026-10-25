import { CONTROL_EVENTS as E, MAX_CONTROL_FRAME_BYTES, SPEEDS, CODEX_UNCONFIRMED_SPEED_WARNING } from "../config/studioControls.js";

// Inspect only envelope metadata. Tool calls, output, and reasoning are never logged.
// Keep sent controls distinct from provider confirmation. ChatGPT's Codex backend
// can return default even when controlled measurements show acceleration.
export async function observeControlResponse(response, controls, onEvent = async () => {}) {
  if (!controls || !response.ok) return response;
  const codex = controls.provider === "codex";
  const expected = controls.tier;
  let reportedTier = null;
  let reportedEffort = null;
  let terminal = false;
  let failed = false;
  let cancelled = false;
  const reject = async (message) => {
    failed = true;
    await onEvent({ state: "failed", reportedTier, reportedEffort, error: message });
    throw new Error(message);
  };
  const complete = async () => {
    if (terminal) return reject("Duplicate upstream completion");
    const unconfirmedCodexSpeed = codex && expected && expected !== "default" && reportedTier === "default";
    if (expected && expected !== "default" && reportedTier !== expected) {
      if (!unconfirmedCodexSpeed) return reject(`Requested ${expected}, but upstream reported ${reportedTier || "no speed"}`);
    }
    if (reportedEffort && controls.effort && reportedEffort !== controls.effort) {
      return reject(`Requested effort ${controls.effort}, but upstream reported ${reportedEffort}`);
    }
    terminal = true;
    await onEvent({ state: "completed", reportedTier, reportedEffort, speedVerified: Boolean(expected && reportedTier === expected),
      ...(unconfirmedCodexSpeed ? { warning: CODEX_UNCONFIRMED_SPEED_WARNING } : {}) });
  };
  const inspect = async (data, eventType) => {
    const type = data.type || eventType;
    if (eventType && data.type && eventType !== data.type) return reject("Conflicting upstream event types");
    if ([E.error, E.failed, E.incomplete].includes(type)) return reject("Upstream response failed or was incomplete");
    const envelope = codex ? data.response || data : data.message || data;
    const speed = codex ? envelope.service_tier : envelope.usage?.speed || data.usage?.speed;
    if (speed) reportedTier = SPEEDS[speed] || speed;
    reportedEffort = envelope.reasoning?.effort || envelope.output_config?.effort || reportedEffort;
    if ((codex && [E.completed, E.done].includes(type)) || (!codex && type === E.messageStop)) {
      if (codex && envelope.status && envelope.status !== "completed") return reject("Upstream response did not complete successfully");
      await complete();
    }
  };
  // Codex forces SSE, including when its gateway omits/mislabels content-type.
  // Match the existing Responses converter's transport rule, not just the header.
  if (!codex && !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const text = await response.text();
    try { await inspect(JSON.parse(text)); if (!terminal) await complete(); }
    catch (error) { if (!failed) await reject("Invalid upstream JSON response"); throw error; }
    return new Response(text, { status: response.status, headers: response.headers });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const frame = async (raw) => {
    const lines = raw.split(/\r?\n/);
    const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    const event = lines.find(l => l.startsWith("event:"))?.slice(6).trim();
    if (data === "[DONE]") {
      if (!terminal) await reject("Upstream ended without a verified completion");
    } else if (data) {
      let parsed;
      try { parsed = JSON.parse(data); } catch { return reject("Invalid upstream SSE JSON"); }
      if (terminal) return reject("Upstream sent data after completion");
      await inspect(parsed, event);
      // Recent Codex backends use response.done; existing translators expect completed.
      if (codex && (event === E.done || parsed.type === E.done)) {
        parsed.type = E.completed;
        return `event: ${E.completed}\ndata: ${JSON.stringify(parsed)}\n\n`;
      }
    }
    return `${raw}\n\n`;
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        let emitted = false;
        while (!emitted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const raw = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          if (raw.length > MAX_CONTROL_FRAME_BYTES) await reject("Upstream SSE frame exceeds inspection limit");
          controller.enqueue(encoder.encode(await frame(raw)));
          emitted = true;
        }
        if (buffer.length > MAX_CONTROL_FRAME_BYTES) await reject("Upstream SSE frame exceeds inspection limit");
        if (done) {
          if (buffer.trim()) controller.enqueue(encoder.encode(await frame(buffer)));
          if (!terminal) await reject("Upstream disconnected before completion");
          controller.close();
          return;
        }
        }
      } catch (error) {
        if (cancelled) return;
        if (!failed) await onEvent({ state: "failed", reportedTier, reportedEffort, error: "Upstream stream interrupted" });
        await reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      // Native Codex closes as soon as it reads response.completed. That is
      // successful consumption, not a cancelled or interrupted model turn.
      if (!terminal && !failed) await onEvent({ state: "cancelled", reportedTier, reportedEffort });
      await reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(stream, { status: response.status, headers });
}
