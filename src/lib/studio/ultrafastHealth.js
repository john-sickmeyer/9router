import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnectionById, getProviderConnections } from "@/lib/localDb";
import { readQuotaDecisions, refreshQuotaInventory } from "./codexQuotaReserve.js";
import { setUltrafastRoutingInTransaction } from "@/lib/db/repos/connectionsRepo.js";
import { isControlDraining, recordControl } from "./audit.js";
import { claimIdleSpeedProbe, releaseIdleSpeedProbe, speedTraffic } from "./speedTraffic.js";
import { enrollUltrafastAccounts, runUltrafastProbe } from "@/sse/services/ultrafastProbe.js";
import { applyLiveSpeed, applyProbeSpeed, newSpeedHealth, speedQualified, speedOwner, SPEED_TIMING, ULTRAFAST_PING,
  SPEED_HEALTH_SCOPE as SCOPE, speedHealthKey as keyFor } from "open-sse/services/ultrafastPolicy.js";
import { ULTRAFAST_BANDS } from "open-sse/services/ultrafastMeasurement.js";

const MODE = "studioUltrafastMode";
const runtime = globalThis[Symbol.for("9router.studio.ultrafast.scheduler")] ||= { timer: null, current: null };
export const speedMonitorEnabled = () => Boolean(process.env.STUDIO_RELEASE) && process.env.STUDIO_CURATED_CATALOG === "1";
export const monitorsUltrafast = controls => speedMonitorEnabled() && controls?.tier === "ultrafast" && ["openai","codex"].includes(controls.provider);

function get(db, key) {
  const value = db.get("SELECT value FROM kv WHERE scope=? AND key=?", [SCOPE, key])?.value;
  return value ? JSON.parse(value) : null;
}
function put(db, key, row) {
  db.run("INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value", [SCOPE, key, JSON.stringify(row)]);
}
function readMode(db) {
  return db.get("SELECT value FROM _meta WHERE key=?", [MODE])?.value === "observe" ? "observe" : "enforce";
}
export async function hasSpeedSuspensions(provider) {
  const db = await getAdapter();
  return readMode(db) === "enforce" && Boolean(db.get(
    "SELECT id FROM providerConnections WHERE provider=? AND isActive=0 AND json_extract(data,'$.studioUltrafastAutoOff') IS NOT NULL LIMIT 1", [provider]));
}

// Run after control, quota, billing, user-disabled and model restrictions.
// Pending evidence blocks accelerated traffic. Two controlled slow pings turn
// off the provider connection, with an ownership marker for automatic recovery.
export async function filterUltrafastAccounts(provider, model, candidates, now = Date.now()) {
  if (!candidates.length) return candidates;
  const db = await getAdapter();
  const admitted = [];
  db.transaction(() => {
    const observe = readMode(db) === "observe";
    for (const connection of candidates) {
      const owner = speedOwner(connection);
      const key = keyFor(provider, connection.id);
      let row = get(db, key);
      if (!row || row.owner !== owner) {
        row = newSpeedHealth(connection.id, provider, owner, now);
        put(db, key, row);
      } else if (now - row.lastDemand >= 60_000) {
        row.lastDemand = now;
        put(db, key, row);
      }
      if (observe || (owner && speedQualified(row, now))) admitted.push(connection);
    }
  });
  startUltrafastMonitor();
  return admitted;
}
export async function recordLiveDelivery(connection, model, delivery) {
  if (!delivery || !connection) return;
  const key = keyFor(connection.provider, connection.id);
  const owner = speedOwner(connection);
  const db = await getAdapter();
  let transition;
  db.transaction(() => {
    const row = get(db,key);
    if (!row || !owner || owner !== row.owner) return;
    const next = applyLiveSpeed(row, model, delivery, Date.now());
    put(db,key,next);
    if (row.status !== next.status) transition = next.status;
  });
  if (transition) await recordControl({ state: "ultrafast-" + transition, requestId: randomUUID(),
    provider: connection.provider, connectionId: connection.id, model, source: "live", delivery });
}

export function startUltrafastMonitor() {
  if (!speedMonitorEnabled() || runtime.timer) return;
  runtime.timer = setInterval(() => {
    if (runtime.current || isControlDraining()) return;
    runtime.current = tick().catch(() => console.error("[Studio] Ultrafast probe scheduler unavailable"))
      .finally(() => { runtime.current = null; });
  }, 2000);
  runtime.timer.unref?.();
}
function enrollNewConnections(now) {
  if (runtime.enrolling || now < (runtime.nextInventory || 0)) return;
  runtime.nextInventory = now + 5 * 60_000;
  runtime.enrolling = Promise.all(["codex","openai"].map(enrollUltrafastAccounts))
    .catch(() => console.error("[Studio] Ultrafast connection inventory unavailable"))
    .finally(() => { runtime.enrolling = null; });
}
async function tick() {
  const db = await getAdapter();
  const now = Date.now();
  refreshQuotaInventory(now);
  enrollNewConnections(now);
  const rows = db.all("SELECT key,value FROM kv WHERE scope=?", [SCOPE]).map(r => ({ key:r.key, ...JSON.parse(r.value) }));
  const group = r => r.provider;
  const serving = new Set(rows.filter(r => speedQualified(r,now)).map(group));
  const due = rows.filter(row => {
    if (row.nextProbe > now || row.lease?.until > now) return false;
    const traffic = speedTraffic(row.connectionId, now);
    return !traffic.requests.length && traffic.quietUntil <= now;
  });
  const rank = r => (serving.has(group(r)) ? 4 : 0) + (r.fastStreak === 1 || r.slowStreak === 1 ? 0 : 1);
  due.sort((a,b) => rank(a) - rank(b) || a.nextProbe - b.nextProbe || a.key.localeCompare(b.key));
  const selected = due[0];
  if (!selected) return;
  const connection = await getProviderConnectionById(selected.connectionId);
  if (!connection || (connection.isActive === false && connection.studioUltrafastAutoOff !== selected.owner) || speedOwner(connection) !== selected.owner) {
    db.transaction(() => { if (get(db,selected.key)?.owner === selected.owner) db.run("DELETE FROM kv WHERE scope=? AND key=?", [SCOPE,selected.key]); });
    return;
  }
  const lease = { id:randomUUID(), until:now + 120_000 };
  const idle = claimIdleSpeedProbe(selected.connectionId);
  if (!idle) return;
  try {
    let claimed = false;
    db.transaction(() => {
      const row = get(db,selected.key);
      if (!row || row.owner !== selected.owner || row.generation !== selected.generation || row.nextProbe > now || row.lease?.until > now) return;
      put(db,selected.key,{ ...row, lease }); claimed = true;
    });
    if (!claimed) return;
    let sample;
    try {
      sample = await runUltrafastProbe(selected, lease.id, idle.signal);
    } catch {
      sample = { classification: "insufficient", reason: "probe-error", retryMs: SPEED_TIMING.retry };
    }
    sample = { ...sample, id: lease.id };
    let status, previous, routingSwitch;
    db.transaction(() => {
      const row = get(db, selected.key);
      if (!row || row.lease?.id !== lease.id) return;
      if (idle.signal.aborted) {
        put(db, selected.key, { ...row, lease:null, nextProbe:Math.max(row.nextProbe, Date.now()+SPEED_TIMING.quiet) });
        return;
      }
      if (selected.generation !== row.generation || selected.owner !== row.owner) {
        put(db,selected.key,{ ...row, lease:null }); return;
      }
      previous = row.status;
      const next = applyProbeSpeed(row, sample, Date.now()); status = next.status;
      if (readMode(db) === "enforce") routingSwitch = applyRoutingSwitch(db, next);
      put(db,selected.key,next);
    });
    if (status) await recordControl({ requestId:lease.id, state: previous !== status ? "ultrafast-" + status : "ultrafast-probe",
      source:"probe", connectionId:selected.connectionId, provider:selected.provider, model:ULTRAFAST_PING.model,
      requestedEffort:ULTRAFAST_PING.effort, requestedTier:ULTRAFAST_PING.tier, delivery:sample,
      ...(routingSwitch ? { routingSwitch } : {}) });
    else if (idle.signal.aborted) await recordControl({ requestId:lease.id, state:"ultrafast-probe-deferred", source:"probe",
      connectionId:selected.connectionId, provider:selected.provider, model:ULTRAFAST_PING.model, reason:"live-traffic-arrived" });
  } finally { releaseIdleSpeedProbe(selected.connectionId, idle); }
}
function applyRoutingSwitch(db, row) {
  if (row.status === "suspended") {
    if (setUltrafastRoutingInTransaction(db,row.connectionId,row.owner,false)) { row.autoOff = true; return "off"; }
  } else if (row.autoOff && speedQualified(row,Date.now())) {
    if (setUltrafastRoutingInTransaction(db,row.connectionId,row.owner,true)) { row.autoOff = false; return "on"; }
  }
}
export async function ultrafastStatus() {
  if (!speedMonitorEnabled()) return { enabled:false };
  startUltrafastMonitor();
  const db = await getAdapter();
  const active = new Map(db.all("SELECT id,isActive FROM providerConnections WHERE provider IN ('openai','codex')").map(c=>[c.id,Boolean(c.isActive)]));
  const reserves = await readQuotaDecisions(await getProviderConnections({ provider:"codex" }));
  const rows = db.all("SELECT value FROM kv WHERE scope=?", [SCOPE]).map(r => {
    const { owner, lease, generation, ...row } = JSON.parse(r.value);
    const traffic = speedTraffic(row.connectionId);
    const speedEligible = speedQualified(row,Date.now());
    const reserve = reserves[row.connectionId];
    return { ...row, speedEligible, connectionActive:active.get(row.connectionId),
      eligible:active.get(row.connectionId) === true && speedEligible && (row.provider !== "codex" || reserve?.routable === true),
      probing:Boolean(lease?.until > Date.now()), activeRequests:traffic.requests, nextProbe:Math.max(row.nextProbe,traffic.quietUntil) };
  }).filter(row=>row.connectionActive !== undefined);
  return { enabled:true, mode:readMode(db), ping:ULTRAFAST_PING, bands:ULTRAFAST_BANDS, rows, reserves };
}
export async function setUltrafastMode(mode) {
  if (!["observe","enforce"].includes(mode)) throw new Error("Unknown Ultrafast mode");
  const db = await getAdapter();
  const switches = [];
  db.transaction(() => {
    db.run("INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [MODE,mode]);
    if (mode !== "enforce") return;
    for (const stored of db.all("SELECT key,value FROM kv WHERE scope=?", [SCOPE])) {
      const row = JSON.parse(stored.value);
      const routingSwitch = applyRoutingSwitch(db,row);
      if (routingSwitch) switches.push({ provider:row.provider, connectionId:row.connectionId, routingSwitch });
      put(db,stored.key,row);
    }
  });
  for (const event of switches) await recordControl({ ...event, requestId:randomUUID(), model:ULTRAFAST_PING.model,
    state:"ultrafast-routing-"+event.routingSwitch, source:"policy" });
}
