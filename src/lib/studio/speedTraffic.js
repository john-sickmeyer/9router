import { createHash } from "node:crypto";
import { SPEED_TIMING } from "open-sse/config/ultrafastHealth.js";

// The Studio serves requests in one Node process. Next route bundles share a
// process-global map. Durable qualifications and diagnostic leases are in SQLite.
const accounts = globalThis[Symbol.for("9router.studio.speedTraffic")] ||= new Map();
const terminal = new Set(["completed", "failed", "cancelled", "bypassed"]);

export function speedSessionId(headers, body) {
  const header = name => headers?.get?.(name) ?? headers?.[name];
  const id = header("session_id") || header("session-id") || header("x-session-id") || body?.session_id || body?.prompt_cache_key;
  if (typeof id !== "string" || !id) return null;
  if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id) || /^c[a-z\d]{24}$/.test(id)) return id;
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function account(id) {
  if (!accounts.has(id)) accounts.set(id, { requests: new Map(), quietUntil: 0, probe: null });
  return accounts.get(id);
}

export function observeSpeedTraffic(entry) {
  if (!entry.connectionId || !entry.requestId || entry.source === "probe" || entry.source === "policy" ||
      !["codex", "openai"].includes(entry.provider)) return;
  const existing = accounts.get(entry.connectionId);
  const previous = existing?.requests.get(entry.requestId);
  if (entry.state === "started" || entry.state === "outbound") {
    const state = existing || account(entry.connectionId);
    if (!previous) state.requests.set(entry.requestId, { requestId: entry.requestId, sessionId: entry.sessionId,
      model: entry.model, tier: entry.requestedTier, effort: entry.requestedEffort, startedAt: Date.now() });
    state.probe?.abort();
  } else if (terminal.has(entry.state) && previous) {
    existing.requests.delete(entry.requestId);
    existing.quietUntil = Date.now() + SPEED_TIMING.quiet;
  } else if (entry.delivery && previous && Number.isFinite(entry.delivery.tps)) {
    previous.delivery = entry.delivery;
  }
}

export function speedTraffic(id, now = Date.now()) {
  const state = accounts.get(id);
  if (state && !state.probe && !state.requests.size && state.quietUntil <= now) accounts.delete(id);
  return { requests: [...(state?.requests.values() || [])], quietUntil: state?.quietUntil || 0 };
}

export function claimIdleSpeedProbe(id) {
  const state = account(id);
  if (state.requests.size || state.probe || state.quietUntil > Date.now()) return null;
  state.probe = new AbortController();
  return state.probe;
}

export function releaseIdleSpeedProbe(id, controller) {
  const state = accounts.get(id);
  if (state?.probe === controller) state.probe = null;
  speedTraffic(id);
}
