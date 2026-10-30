import { MOONSHOT_MODELS_URL, MOONSHOT_TIMEOUT_MS } from "../config/moonshot.js";

export function normalizeMoonshotModels(payload) {
  if (!Array.isArray(payload?.data)) return [];
  return payload.data.filter((model) => typeof model?.id === "string" && model.id.trim())
    .map((model) => ({
      ...model,
      name: model.name || model.id,
      ...(Number.isFinite(model.context_length) ? { contextLength: model.context_length } : {}),
      ...(Array.isArray(model.reasoning_efforts?.valid_efforts)
        ? { thinkingLevels: model.reasoning_efforts.valid_efforts } : {}),
    }));
}

// /models requires authentication on Moonshot; validation never spends credits.
export async function validateMoonshotKey(apiKey, fetchImpl = fetch) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { valid: false, error: "Kimi API Platform key is required" };
  }
  try {
    const response = await fetchImpl(MOONSHOT_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(MOONSHOT_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      const error = response.status === 401 || response.status === 403
        ? "Kimi API Platform rejected this key. Use a Platform key, not a Kimi Code subscription key."
        : `Unable to verify key: Kimi API Platform returned HTTP ${response.status}. Try again later.`;
      return { valid: false, error };
    }
    const payload = await response.json().catch(() => null);
    if (!Array.isArray(payload?.data)
      || payload.data.some((model) => typeof model?.id !== "string" || !model.id.trim())) {
      return { valid: false, error: "Kimi API Platform returned an unexpected model list" };
    }
    return { valid: true, error: null };
  } catch {
    // Do not echo upstream bodies or fetch errors that might contain credentials.
    return { valid: false, error: "Unable to reach Kimi API Platform. Check the connection and try again." };
  }
}
