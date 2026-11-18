export const LITHOSAI_BASE_URL = "https://api.lithosai.cloud/v1";
export const LITHOSAI_MODELS_URL = `${LITHOSAI_BASE_URL}/models`;
export const LITHOS_KIMI_MODEL = {
  id: "kimi-k3.1-pro-ultra",
  upstreamModelId: "moonshotai/Kimi-K3.1-Pro-ultra",
  name: "Kimi K3.1 Pro Ultra (LithosAI)",
};
export const LITHOS_KIMI_ROUTE = `lithosai/${LITHOS_KIMI_MODEL.id}`;
export const LITHOS_KIMI_EFFORTS = ["low", "high", "max"];
export const LITHOS_KIMI_CAPABILITIES = {
  vision: true,
  // Lithos rejects native video_url input. The gateway preserves that request and error.
  videoInput: false,
  reasoning: true,
  tools: true,
  thinkingFormat: "openai",
  thinkingCanDisable: false,
  contextWindow: 1048576,
  // The provider publishes the context window without a separate output limit.
  maxOutput: null,
};

export function isLithosKimiModel(provider, model) {
  if (provider !== "lithosai" || typeof model !== "string") return false;
  const base = model.replace(/\([^()]+\)\s*$/, "");
  return base === LITHOS_KIMI_MODEL.id || base === LITHOS_KIMI_MODEL.upstreamModelId;
}
