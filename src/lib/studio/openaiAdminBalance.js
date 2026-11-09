import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { OPENAI_ADMIN_URL, OPENAI_BALANCE_TTL_MS } from "open-sse/config/openaiPlatform.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

// Each OpenAI API connection is its own organization, so each carries its own
// read-only admin key plus the grants the operator reports. OpenAI's admin API
// exposes billed costs but not grant balances (credit_grants is browser-session
// only), so the balance shown is grants minus billed cost since the first grant.
// The admin key is never used for inference and never returned to the browser.

const ADMIN_KEY = /^sk-admin-[A-Za-z0-9_-]{20,}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_GRANTS = 50;
const MAX_PAGES = 12;
const MAX_PROJECTS = 20;
const REV = "studioOpenaiAdminRev";
const inFlight = globalThis[Symbol.for("9router.studio.openaiAdminBalance")] ||= new Map();
const httpError = (message, status) => Object.assign(new Error(message), { status });

function validDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function normalizeGrants(grants) {
  if (!Array.isArray(grants) || grants.length > MAX_GRANTS) throw new Error(`Provide up to ${MAX_GRANTS} grants`);
  return grants.map(grant => {
    const amountUsd = Number(grant?.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1e7) throw new Error("Each grant needs a positive USD amount");
    if (!validDay(grant.grantedOn)) throw new Error("Each grant needs a valid grant date (YYYY-MM-DD)");
    const expiresOn = grant.expiresOn || null;
    if (expiresOn !== null && (!validDay(expiresOn) || expiresOn < grant.grantedOn)) throw new Error("Expiry must be a valid date on or after the grant date");
    const note = typeof grant.note === "string" ? grant.note.trim().slice(0, 120) : "";
    return { amountUsd: Math.round(amountUsd * 100) / 100, grantedOn: grant.grantedOn, expiresOn, ...(note ? { note } : {}) };
  }).sort((a, b) => a.grantedOn.localeCompare(b.grantedOn));
}

// OpenAI reports costs in UTC daily buckets, so the window starts at UTC midnight
// of the earliest grant date. In US time zones that UTC day begins the evening
// before; usage on earlier UTC days is excluded.
export function billingStart(grants) {
  return grants.length ? new Date(Date.parse(`${grants[0].grantedOn}T00:00:00Z`)) : null;
}

function windowStart(connection, admin) {
  return billingStart(admin.grants || []) || new Date(Date.parse(admin.addedAt || connection.createdAt || 0) || 0);
}

const fingerprint = admin => createHash("sha256").update(`${admin.key}\n${JSON.stringify(admin.grants || [])}`).digest("hex").slice(0, 16);
const keyTail = key => (typeof key === "string" ? key.slice(-4) : "");

// The admin key goes only to api.openai.com: direct (no relay or proxy pool) and
// with certificate verification enforced, so it is never resent over insecure TLS.
async function adminGet(key, path, query = {}) {
  const url = new URL(`${OPENAI_ADMIN_URL}/${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  const response = await proxyAwareFetch(url.toString(), {
    method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20000), redirect: "error", strictTls: true,
  }, null);
  if (response.status === 401 || response.status === 403) throw httpError("OpenAI rejected the admin key", response.status);
  if (!response.ok) throw httpError(`OpenAI returned HTTP ${response.status}`, response.status);
  return response.json();
}

async function readBilledCost(key, start) {
  let page = null, billedUsd = 0;
  const byDay = {};
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await adminGet(key, "costs", {
      start_time: Math.floor(start.getTime() / 1000), bucket_width: "1d", limit: 180, ...(page ? { page } : {}),
    });
    if (!Array.isArray(body?.data)) throw new Error("Unexpected OpenAI costs response");
    for (const bucket of body.data) {
      let day = 0;
      for (const result of bucket.results || []) {
        const value = Number(result?.amount?.value);
        if (result?.amount?.currency && String(result.amount.currency).toLowerCase() !== "usd") throw new Error("OpenAI costs are not in USD");
        if (Number.isFinite(value)) day += value;
      }
      const label = new Date(Number(bucket.start_time) * 1000).toISOString().slice(0, 10);
      if (day) byDay[label] = Math.round(((byDay[label] || 0) + day) * 1e4) / 1e4;
      billedUsd += day;
    }
    if (!body.has_more) return { billedUsd, byDay, complete: true };
    if (!body.next_page) return { billedUsd, byDay, complete: false };
    page = body.next_page;
  }
  return { billedUsd, byDay, complete: false };
}

// Confirms the key works and whether its organization lists this connection's
// inference key (matched on OpenAI's redacted prefix and suffix; a hint, not proof).
async function verifyAdminKey(key, inferenceKey) {
  const projects = await adminGet(key, "projects", { limit: MAX_PROJECTS });
  if (!Array.isArray(projects?.data)) throw new Error("Unexpected OpenAI projects response");
  if (typeof inferenceKey !== "string" || !inferenceKey) return null;
  for (const project of projects.data.slice(0, MAX_PROJECTS)) {
    if (typeof project?.id !== "string" || !/^proj_[A-Za-z0-9]+$/.test(project.id)) continue;
    const keys = await adminGet(key, `projects/${project.id}/api_keys`, { limit: 100 }).catch(() => null);
    for (const item of keys?.data || []) {
      const match = /^(.+?)\*+(.+)$/.exec(item?.redacted_value || "");
      if (match && inferenceKey.startsWith(match[1]) && inferenceKey.endsWith(match[2])) return true;
    }
  }
  return false;
}

function localCost(db, connectionId, start) {
  const row = db.get("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS requests, MAX(timestamp) AS last FROM usageHistory WHERE connectionId = ? AND timestamp >= ?",
    [connectionId, start.toISOString()]);
  return { costUsd: Math.round((row?.cost || 0) * 1e4) / 1e4, requests: row?.requests || 0, lastUsageAt: row?.last || null };
}

function balanceView(connection, admin, local, now = Date.now()) {
  const grants = admin.grants || [];
  const grantsUsd = Math.round(grants.reduce((sum, grant) => sum + grant.amountUsd, 0) * 100) / 100;
  const today = new Date(now).toISOString().slice(0, 10);
  const expiredUsd = grants.filter(g => g.expiresOn && g.expiresOn < today).reduce((sum, grant) => sum + grant.amountUsd, 0);
  const last = admin.lastRead || null;
  const billedUsd = last?.billedUsd ?? null;
  const remainingUsd = billedUsd === null || !grants.length ? null : Math.round((grantsUsd - billedUsd) * 100) / 100;
  return {
    configured: true, keyHint: admin.keyHint, addedAt: admin.addedAt, grants, grantsUsd, expiredUsd,
    billingStart: billingStart(grants)?.toISOString() || null,
    billedUsd, billedByDay: last?.byDay || {}, readAt: last?.readAt || null, readComplete: last?.complete !== false,
    // Remaining is the reported grants minus billed cost. Expired grant value is
    // shown separately because OpenAI decides how expiry applies to past spend.
    remainingUsd, overdrawn: remainingUsd !== null && remainingUsd < 0,
    stale: !last?.readAt || now - Date.parse(last.readAt) > OPENAI_BALANCE_TTL_MS,
    // false: OpenAI's key list for this organization did not include the connection's inference key.
    organizationMatch: admin.organizationMatch ?? null,
    inferenceKeyChanged: Boolean(admin.inferenceKeyTail) && admin.inferenceKeyTail !== keyTail(connection.apiKey),
    error: admin.lastError || null,
    local,
  };
}

// Cached views only: no network. /api/studio (also used by release health checks) calls this.
export async function getOpenaiAdminBalances(connections) {
  const out = {};
  let db = null;
  for (const connection of connections.filter(c => c.provider === "openai")) {
    const admin = connection.studioOpenaiAdmin;
    if (!admin?.key) { out[connection.id] = { configured: false }; continue; }
    db ||= await getAdapter();
    out[connection.id] = balanceView(connection, admin, localCost(db, connection.id, windowStart(connection, admin)));
  }
  return out;
}

// Free, read-only Costs API reads for accounts whose cached read is older than the TTL (or all, when forced).
export async function refreshOpenaiAdminBalances(connections, { force = false } = {}) {
  const due = connections.filter(c => c.provider === "openai" && c.studioOpenaiAdmin?.key
    && (force || !c.studioOpenaiAdmin.lastRead?.readAt || Date.now() - Date.parse(c.studioOpenaiAdmin.lastRead.readAt) > OPENAI_BALANCE_TTL_MS));
  await Promise.all(due.map(c => refreshOpenaiAdminBalance(c.id).catch(() => null)));
  return due.length;
}

// A refresh writes only if no edit landed since it read the connection. The
// revision check runs inside the repository transaction, so concurrent key,
// grant, or removal edits always win. In-flight reads are shared only for the
// same key and grants, so an edit never receives a stale read.
export async function refreshOpenaiAdminBalance(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  const admin = connection?.studioOpenaiAdmin;
  if (!connection || connection.provider !== "openai" || !admin?.key) return null;
  const flightKey = `${connectionId}:${connection[REV] || 0}:${fingerprint(admin)}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);
  const task = (async () => {
    const start = windowStart(connection, admin);
    let next;
    try {
      const read = await readBilledCost(admin.key, start);
      next = { ...admin, lastError: null, lastRead: { readAt: new Date().toISOString(), billedUsd: Math.round(read.billedUsd * 1e4) / 1e4,
        byDay: read.byDay, complete: read.complete, from: start.toISOString() } };
    } catch (error) {
      next = { ...admin, lastError: { message: error.status ? error.message : "Could not read OpenAI costs", at: new Date().toISOString(), status: error.status || null } };
    }
    const saved = await updateProviderConnection(connectionId, { studioOpenaiAdmin: next }, { ifUnchanged: { [REV]: connection[REV] } });
    return saved?.studioOpenaiAdmin ?? null;
  })().finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, task);
  return task;
}

// Applies an edit only if no other edit landed since `connection` was read.
async function commitAdmin(connection, studioOpenaiAdmin) {
  const nextRev = (connection[REV] || 0) + 1;
  const saved = await updateProviderConnection(connection.id, { studioOpenaiAdmin, [REV]: nextRev }, { ifUnchanged: { [REV]: connection[REV] } });
  if (!saved || saved[REV] !== nextRev) throw httpError("This account changed while saving. Reload and try again.", 409);
  return saved;
}

async function openaiConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection || connection.provider !== "openai") throw httpError("OpenAI connection not found", 404);
  return connection;
}

export async function setOpenaiAdminKey(connectionId, key) {
  const connection = await openaiConnection(connectionId);
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!ADMIN_KEY.test(trimmed)) throw httpError("Enter an OpenAI admin key (it starts with sk-admin-)", 400);
  if (trimmed === connection.apiKey) throw httpError("That is the inference key, not an admin key", 400);
  let organizationMatch;
  try { organizationMatch = await verifyAdminKey(trimmed, connection.apiKey); }
  catch (error) {
    throw httpError(error.status === 401 || error.status === 403
      ? "OpenAI rejected this admin key. Check that it is an admin key for this account's organization."
      : "Could not verify the admin key with OpenAI. Try again.", 400);
  }
  // Re-read after the network check so grants edited meanwhile are kept.
  const fresh = await openaiConnection(connectionId);
  await commitAdmin(fresh, { key: trimmed, keyHint: `sk-admin-…${keyTail(trimmed)}`, addedAt: new Date().toISOString(),
    grants: fresh.studioOpenaiAdmin?.grants || [], organizationMatch, inferenceKeyTail: keyTail(fresh.apiKey) });
  return refreshOpenaiAdminBalance(connectionId);
}

export async function removeOpenaiAdminKey(connectionId) {
  await commitAdmin(await openaiConnection(connectionId), null);
}

export async function setOpenaiGrants(connectionId, grants) {
  const connection = await openaiConnection(connectionId);
  if (!connection.studioOpenaiAdmin?.key) throw httpError("Add this account's admin key before recording grants", 400);
  let normalized;
  try { normalized = normalizeGrants(grants); } catch (error) { throw httpError(error.message, 400); }
  // A different window invalidates the cached cost read.
  await commitAdmin(connection, { ...connection.studioOpenaiAdmin, grants: normalized, lastRead: null, lastError: null });
  return refreshOpenaiAdminBalance(connectionId);
}
