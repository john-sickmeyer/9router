import { LITHOSAI_BASE_URL, LITHOSAI_MODELS_URL, LITHOS_KIMI_MODEL, LITHOS_KIMI_EFFORTS } from "../../config/lithosai.js";

export default {
  id: "lithosai",
  priority: 172,
  category: "apikey",
  display: {
    name: "LithosAI",
    icon: "bolt",
    color: "#235F40",
    textIcon: "LA",
    website: "https://www.lithosai.com",
    notice: { apiKeyUrl: "https://console.lithosai.cloud/keys" },
  },
  transport: {
    baseUrl: `${LITHOSAI_BASE_URL}/chat/completions`,
    validateUrl: LITHOSAI_MODELS_URL,
    quirks: { dropClientMetadata: true },
    reasoningInject: { scope: "toolCalls" },
  },
  models: [{ ...LITHOS_KIMI_MODEL, supportedFormats: ["openai"] }],
  thinkingConfig: { options: ["auto", ...LITHOS_KIMI_EFFORTS], defaultMode: "auto" },
};
