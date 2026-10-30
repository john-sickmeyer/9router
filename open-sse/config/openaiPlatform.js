// Reviewed against official model/error documentation on 2026-10-30.
export const OPENAI_METADATA_REVIEWED_AT = "2026-10-30";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
export const OPENAI_POOL_PROVIDER = "studio-openai";
export const OPENAI_POOL_MODELS = ["gpt-6.1-sol", "gpt-6-astra"];
export const OPENAI_CURRENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const OPENAI_CURRENT_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinkingLevels: OPENAI_CURRENT_EFFORTS },
  { id: "gpt-6-astra", name: "GPT-6 Astra", thinkingLevels: OPENAI_CURRENT_EFFORTS },
  ...[["gpt-6.1-terra", "GPT-6.1 Terra"], ["gpt-6-luna", "GPT-6 Luna"], ["gpt-6-sol", "GPT-6 Sol"]]
    .map(([id, name]) => ({ id, name, thinkingLevels: ["none", ...OPENAI_CURRENT_EFFORTS] })),
];
export const OPENAI_POOL_CONTEXT = 272000;
// https://developers.openai.com/api/docs/pricing (reviewed 2026-10-30).
export const OPENAI_PRICE_TIER_MULTIPLIERS = { default: 1, standard: 1, priority: 2, fast: 2, ultrafast: 6, flex: 0.5, batch: 0.5 };
export const OPENAI_LONG_CONTEXT_PRICE = { input: 2, output: 1.5 };
export const OPENAI_METADATA_TTL_MS = 30 * 86400000;
export const OPENAI_BILLING_CODES = new Set([
  "credit_balance_exhausted", "insufficient_quota", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "billing_hard_limit_reached", "usage_limit_reached",
]);
export const OPENAI_BILLING_PROBE_MS = 10 * 60 * 1000;
export const OPENAI_ELIGIBILITY_RECHECK_MS = 6 * 60 * 60 * 1000;
export const isOpenaiPoolEnabled = () => process.env.STUDIO_OPENAI_POOL_ENABLED === "1";
export const isOpenaiPoolModel = (model) => typeof model === "string"
  && !model.includes("/") && OPENAI_POOL_MODELS.includes(model.split(/[@(]/)[0]);
