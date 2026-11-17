import { CODEX_RESERVE } from "../config/ultrafastHealth.js";
import { parseResetTime } from "./usage/shared.js";

export const CODEX_RESERVE_SCOPE = "studioCodexQuotaReserveV1";

function windowFrom(used, reset) {
  if (typeof used !== "number" && !(typeof used === "string" && used.trim())) return null;
  const number = Number(used);
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return { remaining: 100 - number, resetAt: parseResetTime(reset) };
}

const windowName = (seconds, fallback) => Number(seconds) === 7 * 24 * 60 * 60 ? "weekly" :
  Number(seconds) === 5 * 60 * 60 ? "session" : fallback;

export function reserveFromUsage(limit, credits) {
  const result = { session:null, weekly:null, credits: credits ? credits.overage_limit_reached !== true &&
    (credits.unlimited === true || (credits.has_credits === true && Number(credits.balance) > 0)) : null };
  const expected = new Set();
  let declared = 0;
  for (const [key, fallback] of [["primary","session"],["secondary","weekly"]]) {
    if (limit && (Object.hasOwn(limit,key+"_window") || Object.hasOwn(limit,key))) declared++;
    const w = limit?.[key+"_window"] ?? limit?.[key];
    if (!w) continue;
    const name = windowName(w.limit_window_seconds, fallback);
    expected.add(name);
    result[name] = windowFrom(w.used_percent ?? w.percent_used, w.reset_at ?? w.resets_at ?? w.resetAt);
  }
  if (declared === 2 && expected.size) result.expectedWindows = [...expected];
  return result;
}

export function reserveFromHeaders(headers) {
  const result = { session:null, weekly:null };
  for (const [key, fallback] of [["primary","session"],["secondary","weekly"]]) {
    const prefix = "x-codex-" + key + "-";
    const minutes = headers?.get(prefix+"window-minutes");
    if (minutes !== null && minutes !== undefined && Number(minutes) === 0) continue;
    const window = windowFrom(headers?.get(prefix+"used-percent"),headers?.get(prefix+"reset-at"));
    const name = windowName(Number(minutes)*60,fallback);
    if (window && !result[name]) result[name] = window;
  }
  return result;
}

const isHeld = window => window && window.remaining <= CODEX_RESERVE.percent;

// Headers can immediately close routing. Only a complete, newer account usage
// read can lift an existing hold. A partial observation cannot certify capacity.
export function mergeReserve(previous, observation, source, at) {
  if (!observation?.session && !observation?.weekly) return previous;
  if (previous && at < previous.observedAt) return previous;
  const expected = observation.expectedWindows || (source === "headers" && previous?.expectedWindows) || ["session","weekly"];
  const complete = expected.length > 0 && expected.every(name => Boolean(observation[name]));
  const authoritative = source === "usage" && complete;
  const row = { ...previous, observedAt: at };
  if (authoritative) row.expectedWindows = expected;
  for (const name of ["session", "weekly"]) {
    const next = observation[name];
    if (!next) {
      if (authoritative && !expected.includes(name)) delete row[name];
      continue;
    }
    const old = previous?.[name];
    if (!authoritative && isHeld(old) && next.remaining > old.remaining) continue;
    if (source === "headers" && old?.resetAt && old.resetAt === next.resetAt && old.remaining < next.remaining) continue;
    row[name] = next;
  }
  if (typeof observation.credits === "boolean" && source === "usage") row.credits = observation.credits;
  if (complete) row.verifiedAt = at;
  if (source === "usage") row.usageAt = at;
  return row;
}

export function reserveDecision(row, now = Date.now()) {
  const windows = [row?.session, row?.weekly].filter(Boolean);
  const minimum = windows.length ? Math.min(...windows.map(w => w.remaining)) : null;
  const held = windows.some(isHeld);
  const freshMs = minimum !== null && minimum <= CODEX_RESERVE.nearPercent ? CODEX_RESERVE.nearFreshMs : CODEX_RESERVE.freshMs;
  const hasWindows = (row?.expectedWindows || ["session","weekly"]).every(name => Boolean(row?.[name]));
  const verified = Boolean(row?.verifiedAt && windows.length && hasWindows && now - row.verifiedAt < freshMs);
  return { held, verified, routable: verified && !held, remaining: minimum, threshold: CODEX_RESERVE.percent,
    session: row?.session || null, weekly: row?.weekly || null, checkedAt: row?.observedAt || null };
}

export function reserveRefreshDue(row, now = Date.now(), background = false) {
  if (!row) return true;
  const view = reserveDecision(row, now);
  if (view.held) {
    const observed = row.usageAt || 0;
    const resets = [row.session, row.weekly].filter(isHeld).map(w => Date.parse(w.resetAt)).filter(r => r > observed);
    return now >= Math.min(observed + CODEX_RESERVE.heldRecheckMs, ...resets);
  }
  if (!background) return !view.verified;
  const age = view.remaining !== null && view.remaining <= CODEX_RESERVE.nearPercent
    ? CODEX_RESERVE.nearFreshMs : CODEX_RESERVE.freshMs / 2;
  return !view.verified || now - row.verifiedAt >= age;
}
