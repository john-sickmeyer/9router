import { errorResponse } from "open-sse/utils/error.js";
import { resolveControls } from "open-sse/services/studioControls.js";
import { pooledConversationError, normalizePublicResponses } from "open-sse/services/openaiPlatform.js";
import { OPENAI_POOL_MODELS } from "open-sse/config/openaiPlatform.js";

// Only uncommitted HTTP failures reach the next route. An accepted stream is
// returned immediately; later failures never replay model output or tool calls.
export async function routeOpenaiPool({ body, model, requested, providerThinking, run }) {
  const continuityError = pooledConversationError(body);
  if (continuityError) return errorResponse(400, continuityError);
  let controls;
  try {
    controls = resolveControls("openai", model, body, requested, providerThinking);
  } catch (error) { return errorResponse(400, error.message); }
  if (!controls || !OPENAI_POOL_MODELS.includes(controls.model)) return errorResponse(400, "Unsupported shared OpenAI model or controls");
  const tier = controls?.tier || "default";
  const effort = controls?.effort || null;
  const requestBody = { ...structuredClone(body), store: false, service_tier: tier };
  if (effort) requestBody.reasoning = { ...requestBody.reasoning, effort };
  let apiCompatible = true;
  try { normalizePublicResponses(requestBody); } catch { apiCompatible = false; }
  let last;
  const requestId = crypto.randomUUID();
  let fallbackReason = apiCompatible ? null : "conversation-requires-codex";
  for (const provider of apiCompatible ? ["openai", "codex"] : ["codex"]) {
    const outcome = { requestId, fallbackReason };
    last = await run(provider, requestBody, outcome, controls.model);
    if (last.ok) {
      last.headers.set("x-9router-route-policy", "openai-api-first");
      last.headers.set("x-9router-serving-provider", provider);
      if (provider === "codex") last.headers.set("x-9router-fallback-reason", fallbackReason || "api-unavailable");
      return last;
    }
    if (provider !== "openai" || !outcome.canFallback) return last;
    fallbackReason = outcome.reason || "api-unavailable";
    await last.body?.cancel();
  }
  return last || errorResponse(503, "No compatible OpenAI route available");
}
