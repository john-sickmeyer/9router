import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getModelMeta, getModelQuotaFamily } from "open-sse/config/providerModels.js";
import { CODEX_QUOTA_RECHECK_MS, QUOTA_LOOKUP_TIMEOUT_MS } from "open-sse/config/errorConfig.js";
import { MODEL_LOCK_PREFIX } from "open-sse/services/accountFallback.js";
import { controlLockKey } from "open-sse/services/studioControls.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { checkAndRefreshToken } from "./tokenRefresh.js";

const QUOTA_LOCK_PREFIX = "codexQuotaLock_";
const checks = new Map();

export function codexQuotaLockUpdate(model, expiry, status, errorText) {
  return { [`${QUOTA_LOCK_PREFIX}${model || "__all"}`]: isUsageLimit(status, errorText) ? expiry : null };
}

function isUsageLimit(status, errorText) {
  return Number(status) === 429 && /usage[_ ]limit(?:[_ ]reached| has been reached)/i.test(String(errorText || ""));
}

function recoverableLocks(connection) {
  if (connection.provider !== "codex") return [];
  const locks = Object.keys(connection).filter(key => key.startsWith(MODEL_LOCK_PREFIX)
    && Date.parse(connection[key]) > Date.now());
  return locks.filter(key => {
    const quotaKey = QUOTA_LOCK_PREFIX + key.slice(MODEL_LOCK_PREFIX.length);
    if (Object.hasOwn(connection, quotaKey)) return connection[quotaKey] === connection[key];
    // Older records have only one shared error. Its provenance is unambiguous
    // only when exactly one active lock remains.
    return locks.length === 1 && isUsageLimit(connection.errorCode, connection.lastError);
  });
}

export async function reconcileCodexQuota(connection, usage) {
  const keys = recoverableLocks(connection).filter(key => {
    const model = key.slice(MODEL_LOCK_PREFIX.length).split("@")[0];
    if (!getModelMeta("cx", model)) return false;
    return usage?.quotaRecovery?.[getModelQuotaFamily("cx", model)] === true;
  });
  if (!keys.length) return connection;
  const allLocks = Object.keys(connection).filter(key => key.startsWith(MODEL_LOCK_PREFIX));
  const remaining = allLocks.some(key => !keys.includes(key) && Date.parse(connection[key]) > Date.now());
  const patch = Object.fromEntries(keys.flatMap(key => [[key, null],
    [QUOTA_LOCK_PREFIX + key.slice(MODEL_LOCK_PREFIX.length), null]]));
  if (!remaining && Number(connection.errorCode) === 429) Object.assign(patch, {
    testStatus: "unavailable", lastError: null, lastErrorAt: null, errorCode: null, backoffLevel: 0,
  });
  // Compare in the SQLite transaction, not between an async read and write.
  const ifUnchanged = Object.fromEntries(["lastError", "lastErrorAt", "errorCode", ...allLocks].map(key => [key, connection[key]]));
  return await updateProviderConnection(connection.id, patch, { ifUnchanged }) || connection;
}

export async function refreshCodexQuota(connection, { force = false } = {}) {
  if (!recoverableLocks(connection).length) return;
  const state = JSON.stringify([connection.lastErrorAt, recoverableLocks(connection).map(key => [key, connection[key]])]);
  const cached = checks.get(connection.id);
  if (!force && cached?.state === state && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    try {
      const credentials = await checkAndRefreshToken("codex", connection);
      const proxy = await resolveConnectionProxyConfig(credentials.providerSpecificData || {});
      const usage = await getCodexUsage(credentials.accessToken, proxy, {
        providerSpecificData: credentials.providerSpecificData,
        signal: AbortSignal.timeout(QUOTA_LOOKUP_TIMEOUT_MS),
      });
      await reconcileCodexQuota(connection, usage);
    } catch {
      // A failed quota read is not evidence that the lock can be removed.
    }
  })();
  checks.set(connection.id, { state, promise, expiresAt: Date.now() + CODEX_QUOTA_RECHECK_MS });
  return promise;
}

export async function recoverCodexQuotaForSelection(model, controls, excluded, requestedModel) {
  const lockKey = controlLockKey(model, controls);
  const relevant = new Set([`${MODEL_LOCK_PREFIX}${model}`, `${MODEL_LOCK_PREFIX}${lockKey}`, `${MODEL_LOCK_PREFIX}__all`]);
  const connections = (await getProviderConnections({ provider: "codex", isActive: true })).filter(connection => {
    const enabled = connection.providerSpecificData?.enabledModels;
    return !excluded.has(connection.id)
      && !(Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel));
  });
  const locked = connection => [...relevant].some(key => Date.parse(connection[key]) > Date.now());
  if (connections.some(connection => !locked(connection))) return;
  await Promise.all(connections.filter(connection => connection.accessToken
    && recoverableLocks(connection).some(key => relevant.has(key))).map(connection => refreshCodexQuota(connection)));
}
