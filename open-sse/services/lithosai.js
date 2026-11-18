import { LITHOSAI_MODELS_URL, LITHOS_KIMI_MODEL, LITHOS_KIMI_EFFORTS, LITHOS_KIMI_CAPABILITIES } from "../config/lithosai.js";

export function lithosKimiModels(payload) {
  const model = Array.isArray(payload?.data)
    && payload.data.find(entry => entry?.id === LITHOS_KIMI_MODEL.upstreamModelId);
  return model ? [{
    ...model, ...LITHOS_KIMI_MODEL,
    contextLength: LITHOS_KIMI_CAPABILITIES.contextWindow, thinkingLevels: LITHOS_KIMI_EFFORTS,
  }] : [];
}

export async function validateLithosKey(apiKey, fetchImpl = fetch) {
  if (typeof apiKey !== "string" || !apiKey.trim()) return { valid: false, error: "LithosAI key is required" };
  try {
    const response = await fetchImpl(LITHOSAI_MODELS_URL, {
      method: "GET", headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { valid: false, error: `LithosAI model discovery returned HTTP ${response.status}.` };
    const payload = await response.json();
    if (!lithosKimiModels(payload).length) return { valid: false, error: "LithosAI did not list Kimi K3.1 Pro Ultra for this key." };
    return { valid: true, error: null };
  } catch {
    return { valid: false, error: "Unable to retrieve the LithosAI model list." };
  }
}
