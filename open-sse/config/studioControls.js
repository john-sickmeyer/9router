// Studio fork: explicit controls, separate from the generated provider registry.
// Source: per-account Codex model catalog and the providers' speed/effort docs.
export const STUDIO_CONTROL_VERSION = 1;
export const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;
export const CODEX_CATALOG_VERSION = "0.163.0";
export const CODEX_CATALOG_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_VERSION}`;
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CONTROL_PROVIDERS = new Set(["codex", "claude", "anthropic"]);
export const SPEEDS = { standard: "default", default: "default", auto: "default", fast: "priority", priority: "priority", ultrafast: "ultrafast" };
export const CODEX_EFFORTS = {
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
};
export const CLAUDE_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
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
