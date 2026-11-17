// Measure user-visible text on the provider stream. Multiple SSE events in one
// transport read share a timestamp. No prompts or output survive the measurement.
import { ULTRAFAST_BANDS } from "../config/ultrafastHealth.js";
export { ULTRAFAST_BANDS } from "../config/ultrafastHealth.js";
const MAX_CHARS = 32768;
let encoding;
async function tokenizer() {
  encoding ??= Promise.all([import("js-tiktoken/lite"), import("js-tiktoken/ranks/o200k_base")])
    .then(([{ Tiktoken }, ranks]) => new Tiktoken(ranks.default))
    .catch(error => { encoding = undefined; throw error; });
  return encoding;
}

export function createUltrafastMeasurement(expectedText = null) {
  let text = "", first = null, last = null, firstChars = 0, reads = 0;
  let mixed = false, capped = false, consumerStalled = false, lastChecked = null;
  return {
    consumerPause(milliseconds) {
      if (first !== null && milliseconds >= 250) consumerStalled = true;
    },
    observe(event, at) {
      const type = typeof event.type === "string" ? event.type : "";
      const choices = Array.isArray(event.choices) ? event.choices : [];
      if (type.includes("function_call") || type.includes("tool_call") ||
          (type === "response.output_item.added" && !["message", "reasoning"].includes(event.item?.type)) ||
          choices.some(c => c.delta?.tool_calls?.length || c.delta?.function_call)) mixed = true;
      if (choices.length > 1 || choices.some(c => c.index > 0) ||
          (first !== null && (type.includes("reasoning") || event.item?.type === "reasoning" ||
            choices.some(c => c.delta?.reasoning_content || c.delta?.reasoning)))) mixed = true;
      const delta = type === "response.output_text.delta" ? event.delta : choices[0]?.delta?.content;
      if (typeof delta !== "string" || !delta || at == null || capped) return;
      if (text.length + delta.length > MAX_CHARS) { capped = true; return; }
      first ??= at;
      if (last !== at) reads++;
      last = at;
      text += delta;
      if (at === first) firstChars = text.length;
    },
    dueForLiveCheck() {
      if (expectedText !== null || mixed || consumerStalled || capped || reads < 8 || text.length < 768 || last - first < 4000 ||
          (lastChecked !== null && last - lastChecked < 8000)) return false;
      lastChecked = last;
      return true;
    },
    async finish(final = true) {
      // Snapshot before awaiting the encoder. The stream can continue while a
      // mid-response sample is being scored.
      const captured = text, headChars = firstChars;
      const durationMs = first === null ? 0 : last - first;
      const sample = { classification: "insufficient", tps: null, reads, durationMs: Math.round(durationMs),
        referenceTokens: null, tokensAfterFirst: null, encoding: "o200k_base", capped, sampledAt:Date.now() };
      if (final) text = "";
      if (expectedText !== null && (capped || captured !== expectedText)) return { ...sample, reason: "output-mismatch" };
      if (mixed) return { ...sample, reason: "mixed-output" };
      if (consumerStalled) return { ...sample, reason: "consumer-backpressure" };
      if (reads < 3 || durationMs <= 0 || captured.length < 256) return { ...sample, reason: "short-or-buffered" };
      try {
        const enc = await tokenizer();
        // Count literal text even if a response prints a tokenizer special string.
        const full = enc.encode(captured, [], []);
        const head = enc.encode(captured.slice(0, headChars), [], []);
        sample.referenceTokens = full.length;
        sample.tokensAfterFirst = full.length - head.length;
        if (full.length < ULTRAFAST_BANDS.minTokens || sample.tokensAfterFirst < ULTRAFAST_BANDS.minAfterFirst) {
          return { ...sample, reason: "short-or-buffered" };
        }
        const rate = 1000 * sample.tokensAfterFirst / durationMs;
        sample.tps = Math.round(rate * 10) / 10;
        sample.classification = rate <= ULTRAFAST_BANDS.slowMax ? "slow" : rate >= ULTRAFAST_BANDS.fastMin ? "fast" : "indeterminate";
        return sample;
      } catch {
        return { ...sample, reason: "tokenizer-unavailable" };
      }
    },
  };
}
