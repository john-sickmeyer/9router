import { MOONSHOT_BASE_URL, MOONSHOT_MODELS_URL } from "../../config/moonshot.js";

export default {
  id: "moonshot",
  priority: 171,
  alias: "moonshot",
  aliases: ["kimi-platform"],
  display: {
    name: "Kimi API Platform",
    icon: "psychology",
    color: "#1E3A8A",
    textIcon: "KM",
    website: "https://platform.kimi.ai",
    notice: {
      text: "Pay-as-you-go keys from platform.kimi.ai / platform.moonshot.ai. Kimi Code subscription keys use the separate Kimi Code provider.",
      apiKeyUrl: "https://platform.kimi.ai/console/api-keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: `${MOONSHOT_BASE_URL}/chat/completions`,
    validateUrl: MOONSHOT_MODELS_URL,
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
    reasoningInject: { scope: "all" },
  },
  models: [
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    { id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
  ],
  features: { usage: true, usageApikey: true },
};
