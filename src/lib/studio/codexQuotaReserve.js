import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { reconcileCodexQuota } from "@/sse/services/codexQuota.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { QUOTA_LOOKUP_TIMEOUT_MS } from "open-sse/config/errorConfig.js";
import { CODEX_RESERVE } from "open-sse/config/ultrafastHealth.js";
import { CODEX_RESERVE_SCOPE as scope, mergeReserve, reserveDecision, reserveFromHeaders,
  reserveRefreshDue } from "open-sse/services/codexQuotaReserve.js";
import { getModelQuotaFamily } from "open-sse/config/providerModels.js";
import { speedOwner } from "open-sse/services/ultrafastPolicy.js";
import { recordControl } from "./audit.js";
import { speedTraffic } from "./speedTraffic.js";

const runtime = globalThis[Symbol.for("9router.studio.codexQuotaReserve")] ||= { checking: new Map(), retryAt: new Map() };
const admissions = globalThis[Symbol.for("9router.studio.codexNearQuotaAdmissions")] ||= new Map();
export const reserveEnabled = () => Boolean(process.env.STUDIO_RELEASE) && process.env.STUDIO_CURATED_CATALOG === "1";

function read(db, connection) {
  const data = db.get("SELECT value FROM kv WHERE scope=? AND key=?", [scope, connection.id]);
  if (!data) return null;
  const row = JSON.parse(data.value);
  return row.owner === speedOwner(connection) ? row : null;
}

export async function saveReserve(connection, evidence, source, observedAt = Date.now()) {
  if (!reserveEnabled() || connection?.provider !== "codex" || (!evidence?.session && !evidence?.weekly)) return;
  const owner = speedOwner(connection);
  if (!owner) return;
  const db = await getAdapter();
  let transition;
  db.transaction(() => {
    const current = db.get("SELECT provider,data FROM providerConnections WHERE id=?", [connection.id]);
    if (!current || speedOwner({ ...JSON.parse(current.data), provider:current.provider }) !== owner) return;
    const previous = read(db, connection);
    const next = mergeReserve(previous, evidence, source, observedAt);
    if (next === previous) return;
    db.run("INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value",
      [scope, connection.id, JSON.stringify({ ...next, owner })]);
    const decision = reserveDecision(next);
    if (decision.held !== reserveDecision(previous).held) transition = decision;
  });
  if (transition) await recordControl({ requestId:randomUUID(), connectionId:connection.id, provider:"codex",
    source:"policy", state:transition.held ? "codex-quota-reserve-held" : "codex-quota-reserve-released",
    quotaRemaining:transition.remaining, sessionRemaining:transition.session?.remaining, weeklyRemaining:transition.weekly?.remaining });
}

export function observeQuotaHeaders(connection, model, headers) {
  if (!reserveEnabled() || connection?.provider !== "codex" || getModelQuotaFamily("cx",model) !== "normal") return;
  return saveReserve(connection, reserveFromHeaders(headers), "headers");
}

// Separate simultaneous ordinary requests near the boundary. A fresh reading
// after the previous request completes is required before another admission.
export function claimNearQuota(connection, decision) {
  if (decision?.remaining > CODEX_RESERVE.nearPercent || !decision?.routable) return;
  admissions.set(connection.id, { owner:speedOwner(connection), at:Date.now() });
}

export function finishNearQuota(id) {
  const claim = admissions.get(id);
  if (claim) claim.at = Date.now();
}

function nearAdmission(connection, row, view, now) {
  if (!view.routable || view.remaining > CODEX_RESERVE.nearPercent) return view.routable;
  if (speedTraffic(connection.id, now).requests.length) return false;
  const claim = admissions.get(connection.id);
  return !claim || claim.owner !== speedOwner(connection) || (row.verifiedAt > claim.at && now - claim.at >= 1000);
}

function refresh(connection, now) {
  const key = connection.id + ":" + speedOwner(connection);
  if (runtime.checking.has(key)) return runtime.checking.get(key);
  if ((runtime.retryAt.get(key) || 0) > now) return;
  const task = (async () => {
    try {
      if (!connection.accessToken || !speedOwner(connection)) throw new Error("No account binding");
      const credentials = await checkAndRefreshToken("codex", connection);
      const proxy = await resolveConnectionProxyConfig(credentials.providerSpecificData);
      const usage = await getCodexUsage(credentials.accessToken, proxy, {
        providerSpecificData:credentials.providerSpecificData, signal:AbortSignal.timeout(QUOTA_LOOKUP_TIMEOUT_MS) });
      await saveReserve(connection, usage.quotaReserve, "usage", now);
      await reconcileCodexQuota(connection, usage);
      const required = usage.quotaReserve?.expectedWindows || ["session","weekly"];
      if (!required.every(name => Boolean(usage.quotaReserve?.[name]))) throw new Error("Incomplete quota");
      runtime.retryAt.delete(key);
    } catch {
      runtime.retryAt.set(key, Date.now() + CODEX_RESERVE.errorRetryMs);
    }
  })().finally(() => runtime.checking.delete(key));
  runtime.checking.set(key,task);
  return task;
}

// Network I/O always precedes the shared selection mutex. A fresh alternative
// can serve immediately while quota readings on other accounts are refreshed.
export async function prepareQuotaReserve(connections, background = false) {
  if (!connections.length) return;
  const db = await getAdapter();
  const now = Date.now();
  let ready = false;
  const pending = [];
  for (const connection of connections) {
    const row = read(db, connection);
    const view = reserveDecision(row, now);
    const canRoute = nearAdmission(connection, row, view, now);
    if (canRoute) ready = true;
    const near = view.routable && !canRoute && !speedTraffic(connection.id, now).requests.length;
    if (near || reserveRefreshDue(row, now, background)) pending.push(refresh(connection, now));
  }
  if (background || !ready) await Promise.all(pending);
}

export function refreshQuotaInventory(now) {
  if (!reserveEnabled() || runtime.inventory || now < (runtime.nextInventory || 0)) return;
  runtime.nextInventory = now + 30_000;
  runtime.inventory = getProviderConnections({ provider:"codex" })
    .then(rows => prepareQuotaReserve(rows.filter(r => r.isActive !== false || r.studioUltrafastAutoOff), true))
    .catch(() => console.warn("[Studio] Codex quota inventory unavailable"))
    .finally(() => { runtime.inventory = null; });
}

export async function readQuotaDecisions(connections) {
  const db = await getAdapter();
  return Object.fromEntries(connections.map(connection => {
    const row = read(db, connection);
    const decision = reserveDecision(row);
    // Diagnostic generation at a reported zero requires separately funded credits.
    // A held account with a positive remainder can spend its reserve on the ping.
    const funded = decision.remaining > 0 || (decision.remaining === 0 && row?.credits === true);
    const known = (row?.expectedWindows || ["session","weekly"]).every(name => Boolean(row?.[name]));
    const pingAllowed = Boolean(known && funded &&
      Date.now() - (row.verifiedAt || 0) < CODEX_RESERVE.heldRecheckMs + CODEX_RESERVE.errorRetryMs);
    return [connection.id, { ...decision, pingAllowed, admissionAvailable:nearAdmission(connection,row,decision,Date.now()) }];
  }));
}
