// Studio fork: explicit controls, separate from the generated provider registry.
// Source: per-account Codex model catalog and the providers' speed/effort docs.
export const STUDIO_CONTROL_VERSION = 1;
export const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;
export const CODEX_CATALOG_VERSION = "0.163.0";
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
export const CODEX_UNCONFIRMED_SPEED_WARNING = "Codex did not confirm the served speed. Its ChatGPT endpoint can report default even when acceleration is observed; this is not proof of a downgrade or the billed tier.";
export const CODEX_RUNTIME_ONLY_EFFORTS = new Set(["ultra"]);
export const CODEX_RUNTIME_EFFORT_ERROR = "Unsupported effort 'ultra' on the inference API. Ultra is a Codex runtime orchestration mode; select it in a compatible native client. For a router model alias, choose an API effort such as max. Ultrafast speed is supported separately.";
export const CODEX_CATALOG_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_VERSION}`;
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CONTROL_PROVIDERS = new Set(["codex", "claude", "anthropic"]);
export const SPEEDS = { standard: "default", default: "default", auto: "default", fast: "priority", priority: "priority", ultrafast: "ultrafast" };
export const CODEX_EFFORTS = {
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
};
export const CLAUDE_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
// Claude Fast spends extra-usage credits immediately. This Studio opts out.
export const CLAUDE_FAST_ENABLED = process.env.STUDIO_CLAUDE_FAST_ENABLED === "1";
export const isStudioCuratedCatalogEnabled = () => process.env.STUDIO_CURATED_CATALOG === "1";
export const STUDIO_VISIBLE_MODELS = [
  { id: "cx/gpt-6.1-sol", provider: "codex", name: "GPT-6.1 Sol" },
  { id: "cx/gpt-6-astra", provider: "codex", name: "GPT-6 Astra" },
  { id: "cc/claude-opus-5-5", provider: "claude", name: "Claude Opus 5.5" },
  { id: "cc/claude-fable-5-1", provider: "claude", name: "Claude Fable 5.1" },
];
export const CLAUDE_EFFORTS = {
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh"],
};
export const SPEED_NAMES = { default: "Standard", priority: "Fast", ultrafast: "Ultrafast" };
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;
export const CONTROL_EVENTS = {
  completed: "response.completed", done: "response.done", failed: "response.failed",
  incomplete: "response.incomplete", error: "error", messageStart: "message_start",
  messageDelta: "message_delta", messageStop: "message_stop",
};
