import { createHash } from "node:crypto";
import { SPEED_TIMING } from "../config/ultrafastHealth.js";
export { SPEED_TIMING, ULTRAFAST_PING } from "../config/ultrafastHealth.js";

export const SPEED_HEALTH_SCOPE = "studioUltrafastHealthV1";
export const speedHealthKey = (provider, id) => JSON.stringify([provider, id]);

function savedCodexAccount(token) {
  if (typeof token !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const account = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof account === "string" && account.length ? account : null;
  } catch { return null; }
}

export function speedOwner(connection) {
  const data = connection.providerSpecificData || {};
  const id = connection.provider === "codex"
    ? data.workspaceId || data.chatgptAccountId || data.accountId || savedCodexAccount(connection.accessToken) || connection.accessToken
    : connection.apiKey;
  return id ? createHash("sha256").update(id).digest("hex") : null;
}

export function newSpeedHealth(connectionId, provider, owner, now) {
  return { connectionId, provider, owner, status: "untested", fastStreak: 0, slowStreak: 0,
    suspensions: 0, qualifiedUntil: 0, lastDemand: now, nextProbe: now, generation: 0 };
}

export function speedQualified(row, now) {
  return row?.status === "qualified" && row.qualifiedUntil > now;
}

function qualify(next, at) {
  Object.assign(next, { status: "qualified", lastPass: at, qualifiedUntil: at + SPEED_TIMING.freshness,
    nextProbe: at + SPEED_TIMING.freshness - SPEED_TIMING.refreshLead, suspensions: 0 });
}

// Only the controlled Sol Light workload confirms a speed tier. Two
// independent requests protect against intermittent or locally buffered delivery.
function applyEvidence(next, sample, at) {
  if (sample.classification === "fast") {
    next.slowStreak = 0;
    next.fastStreak = next.status === "qualified" && !speedQualified(next, at)
      ? 1 : Math.min(2, next.fastStreak + 1);
    if (speedQualified(next, at) || next.fastStreak >= 2) {
      qualify(next, at);
    } else {
      if (next.status !== "suspended") next.status = "checking";
      next.nextProbe = at + SPEED_TIMING.confirm;
    }
  } else if (sample.classification === "slow") {
    next.fastStreak = 0;
    next.slowStreak = Math.min(2, next.slowStreak + 1);
    next.qualifiedUntil = 0;
    if (next.status === "suspended" || next.slowStreak >= 2) {
      next.status = "suspended";
      next.suspensions = Math.min(4, next.suspensions + 1);
      next.nextProbe = at + Math.min(SPEED_TIMING.maxRecovery, SPEED_TIMING.recovery * 2 ** (next.suspensions - 1));
    } else {
      next.status = "checking";
      next.nextProbe = at + SPEED_TIMING.confirm;
    }
  }
}

export function applyLiveSpeed(row, model, delivery, now) {
  if (!delivery) return row;
  const at = delivery.sampledAt ?? now;
  const observation = { ...delivery, at, model };
  const next = { ...row };
  if (!row.lastObservation || row.lastObservation.at <= at) next.lastObservation = observation;
  if (!Number.isFinite(delivery.tps)) return next;
  if (!row.lastLive || row.lastLive.at <= at) next.lastLive = observation;
  if (!row.liveByModel?.[model] || row.liveByModel[model].at <= at) {
    next.liveByModel = { ...row.liveByModel, [model]: observation };
  }
  if (at >= (row.lastEvidenceAt ?? 0) && delivery.classification === "slow" && row.status === "qualified") {
    Object.assign(next, { status: "checking", fastStreak: 0, slowStreak: 0, qualifiedUntil: 0,
      nextProbe: at, generation: row.generation + 1 });
  }
  return next;
}

export function applyProbeSpeed(row, sample, now) {
  const next = { ...row, lastProbe: { ...sample, at: now }, lease: null };
  if (["fast", "slow"].includes(sample.classification)) {
    applyEvidence(next, sample, now);
    next.lastEvidenceAt = now;
  } else {
    // Network and quota failures supply no speed evidence in either direction.
    next.fastStreak = 0;
    next.slowStreak = 0;
    if (sample.classification === "indeterminate" && next.status === "qualified") {
      next.status = "checking";
      next.qualifiedUntil = 0;
    }
    next.nextProbe = now + Math.max(SPEED_TIMING.retry, sample.retryMs || 0);
  }
  return next;
}
