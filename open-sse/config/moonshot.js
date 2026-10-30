// Kimi API Platform (pay-as-you-go), distinct from Kimi Code subscriptions.
export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_MODELS_URL = `${MOONSHOT_BASE_URL}/models`;
export const MOONSHOT_BALANCE_URL = `${MOONSHOT_BASE_URL}/users/me/balance`;
export const MOONSHOT_K3_PATTERN = /^kimi-k3(?:[.-]|$)/i;
export const MOONSHOT_K3_EFFORTS = ["low", "high", "max"];
export const MOONSHOT_TIMEOUT_MS = 15000;
export const MOONSHOT_K3_CONTEXT = 1048576;
export const STUDIO_KIMI_MODELS = [
  { id: "moonshot/kimi-k3.1-pro", provider: "moonshot", name: "Kimi K3.1 Pro" },
  { id: "moonshot/kimi-k3.1-pro-highspeed", provider: "moonshot", name: "Kimi K3.1 Pro Highspeed" },
];
