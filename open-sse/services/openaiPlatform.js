import { OPENAI_BILLING_CODES } from "../config/openaiPlatform.js";
import { MAX_CONTROL_FRAME_BYTES } from "../config/studioControls.js";
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";

export function classifyOpenaiFailure(status, code, type, param) {
  // Specific rate-limit codes take precedence over the broad insufficient_quota type.
  if (OPENAI_BILLING_CODES.has(code) || (!code && type === "insufficient_quota")) return "billing";
  if (status === 400 && (code === "invalid_service_tier" || param === "service_tier")) return "tier";
  if (status === 404 && code === "model_not_found") return "model";
  if (code === "invalid_encrypted_content") return "continuity";
  if ([401, 402, 403, 408, 429].includes(status) || status >= 500) return "capacity";
  return null;
}

// Lite carries tool declarations inside input. Public Responses uses top-level tools.
// Keep definitions byte-for-byte equivalent; conflicting declarations are not mergeable.
export function normalizePublicResponses(body) {
  const result = structuredClone(body);
  const tools = [...(Array.isArray(result.tools) ? result.tools : [])];
  const seen = new Map(tools.map(tool => [`${tool.type}:${tool.name || ""}`, JSON.stringify(tool)]));
  if (Array.isArray(result.input)) {
    let conversationStarted = false;
    result.input = result.input.filter(item => {
      if (item?.type !== "additional_tools") {
        if (item?.role !== "developer" && item?.role !== "system") conversationStarted = true;
        return true;
      }
      if (conversationStarted || !Array.isArray(item.tools)) {
        throw new Error("Cannot move an in-conversation Lite tool update to public Responses without changing its meaning");
      }
      for (const tool of item.tools) {
        const key = `${tool.type}:${tool.name || ""}`;
        const encoded = JSON.stringify(tool);
        if (seen.has(key) && seen.get(key) !== encoded) throw new Error("Conflicting Lite tool declarations");
        if (!seen.has(key)) { tools.push(tool); seen.set(key, encoded); }
      }
      return false;
    });
  }
  if (result.tools === null || tools.length) result.tools = tools;
  return result;
}

export function pooledConversationError(body) {
  if (body.previous_response_id || body.conversation || body.store === true) {
    return "The shared OpenAI pool requires complete conversation history and store:false. Use an explicit provider route for stored conversations.";
  }
  const scoped = new Set(["file_id", "vector_store_ids", "container_id"]);
  const hasScopedResource = value => {
    if (!value || typeof value !== "object") return false;
    if (value.type === "item_reference") return true;
    return Object.entries(value).some(([key, child]) =>
      (scoped.has(key) && (typeof child === "string" || Array.isArray(child))) || hasScopedResource(child));
  };
  return hasScopedResource(body.input) || hasScopedResource(body.tools)
    ? "Account-specific files or stored items require an explicit provider route; the shared pool cannot safely transfer them."
    : null;
}

// Some Responses failures arrive inside HTTP 200 SSE. Inspect only the prefix
// before model output; once reasoning/tool/text output begins, never replay it.
export async function preflightOpenaiStream(response) {
  if (!response.ok || !response.body) return response;
  const failure = error => {
    const status = classifyOpenaiFailure(400, error.code, error.type, error.param) === "billing" ? 429
      : error.type === "invalid_request_error" ? 400 : error.type === "rate_limit_error" ? 429 : 503;
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return new Response(JSON.stringify({ error }), { status, headers });
  };
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    // Do not tee a large inference response: read once and replay its exact text.
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { /* The response observer reports malformed JSON. */ }
    if (payload?.status === "failed" && !payload.output?.length && payload.error) return failure(payload.error);
    return new Response(text, { status: response.status, headers: response.headers });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let buffer = "";
  let size = 0;
  let finished = false;
  let committed = false;
  try {
  while (!finished && !committed && size < MAX_CONTROL_FRAME_BYTES) {
    let timer;
    const { done, value } = await Promise.race([
      reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OpenAI stream stalled before output")), STREAM_STALL_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    finished = done;
    if (value) { chunks.push(value); size += value.byteLength; }
    buffer += decoder.decode(value, { stream: !done });
    if (done && buffer.trim()) buffer += "\n\n";
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      const type = event.type || frame.split(/\r?\n/).find(line => line.startsWith("event:"))?.slice(6).trim();
      if (["error", "response.failed"].includes(type) && !event.response?.output?.length) {
        const error = event.response?.error || event.error || event;
        await reader.cancel().catch(() => {});
        return failure(error);
      }
      if (event.choices?.length || event.response?.output?.length || /^response\.(?:output_|reasoning|function_call|custom_tool_call)/.test(type || "")
        || ["response.completed", "response.done", "response.incomplete"].includes(type)) {
        committed = true;
        break;
      }
    }
  }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (finished) controller.close(); },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { status: response.status, headers: response.headers });
}
