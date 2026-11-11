import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { CLAUDE_QUOTA_RECHECK_MS, CLAUDE_QUOTA_RESET_TOLERANCE_MS, QUOTA_LOOKUP_TIMEOUT_MS } from "open-sse/config/errorConfig.js";
import { MODEL_LOCK_PREFIX, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { checkAndRefreshToken } from "./tokenRefresh.js";
import { getClaudeQuotaBlock } from "./claudeQuota.js";

const QUOTA_LOCK_PREFIX = "claudeQuotaLock_";
const checks = new Map();
const metadataKey = key => QUOTA_LOCK_PREFIX + key.slice(MODEL_LOCK_PREFIX.length);
const activeLocks = connection => Object.keys(connection).filter(key => key.startsWith(MODEL_LOCK_PREFIX)
  && Date.parse(connection[key]) > Date.now());
const quotaNames = (key) => {
  if (key === MODEL_LOCK_ALL) return ["session (5h)", "weekly (7d)"];
  const family = /^modelLock_claude-([a-z]+)-/.exec(key)?.[1];
  return family ? [`weekly ${family} (7d)`] : [];
};

export function claudeQuotaLockUpdate(model, expiry, status, quota) {
  return { [`${QUOTA_LOCK_PREFIX}${model || "__all"}`]: Number(status) === 429 && quota?.name
    ? { expiry, window: quota.name } : null };
}

function lockWindow(connection, key, usage) {
  const metadata = connection[metadataKey(key)];
  if (metadata !== undefined) return metadata?.expiry === connection[key] ? metadata.window : null;
  if ([401, 403].includes(Number(connection.errorCode))) return null;
  // Legacy records shared one lastError across models. Match the lock's exact
  // reset time to a real quota window instead of trusting that unrelated error.
  return quotaNames(key).find(name => {
    const reset = Date.parse(usage?.quotas?.[name]?.resetAt);
    return Number.isFinite(reset) && Math.abs(reset - Date.parse(connection[key])) <= CLAUDE_QUOTA_RESET_TOLERANCE_MS;
  }) || null;
}

export async function reconcileClaudeQuota(connection, usage) {
  if (connection.provider !== "claude" || !usage?.quotas) return connection;
  const locks = activeLocks(connection);
  const windows = new Map(locks.map(key => [key, lockWindow(connection, key, usage)]));
  const clear = locks.filter(key => {
    const window = windows.get(key);
    const remaining = usage.quotas[window]?.remainingPercentage;
    if (!window || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0
      || !Number.isFinite(Date.parse(usage.quotas[window]?.resetAt))) return false;
    // A reset of one window cannot override another exhausted applicable window.
    const model = key === MODEL_LOCK_ALL ? null : key.slice(MODEL_LOCK_PREFIX.length).split("@")[0];
    return !getClaudeQuotaBlock(usage, model);
  });
  // Learn the quota scope of existing locks before a later reset can move the
  // window's timestamp. This migrates old records only from matching live data.
  const learned = locks.filter(key => connection[metadataKey(key)] === undefined && windows.get(key));
  if (!clear.length && !learned.length) return connection;
  const patch = Object.fromEntries([
    ...learned.map(key => [metadataKey(key), { expiry: connection[key], window: windows.get(key) }]),
    ...clear.flatMap(key => [[key, null], [metadataKey(key), null]]),
  ]);
  if (clear.length && !locks.some(key => !clear.includes(key))) Object.assign(patch, {
    testStatus: "unavailable", lastError: null, lastErrorAt: null, errorCode: null, backoffLevel: 0,
  });
  const ifUnchanged = Object.fromEntries([...Object.keys(connection).filter(key => key.startsWith(MODEL_LOCK_PREFIX)),
    "lastError", "lastErrorAt", "errorCode"].map(key => [key, connection[key]]));
  return await updateProviderConnection(connection.id, patch, { ifUnchanged }) || connection;
}

export async function refreshClaudeQuota(connection, { force = false } = {}) {
  const locks = activeLocks(connection);
  if (!locks.length) return;
  const state = JSON.stringify([connection.lastErrorAt, locks.map(key => [key, connection[key]])]);
  const cached = checks.get(connection.id);
  if (cached?.state === state) {
    if (cached.pending) {
      if (!force) return cached.promise;
      await cached.promise; // A reset needs a new read after any pre-reset lookup.
    } else if (!force && cached.expiresAt > Date.now()) return cached.promise;
  }
  const entry = { state, pending: true, expiresAt: Date.now() + CLAUDE_QUOTA_RECHECK_MS };
  entry.promise = (async () => {
    const signal = AbortSignal.timeout(QUOTA_LOOKUP_TIMEOUT_MS);
    const deadline = new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    try {
      await Promise.race([deadline, (async () => {
        const credentials = await checkAndRefreshToken("claude", connection);
        if (signal.aborted) return;
        const proxy = await resolveConnectionProxyConfig(credentials.providerSpecificData || {});
        const usage = await getClaudeUsage(credentials.accessToken, proxy, { force: true, signal });
        if (!signal.aborted) await reconcileClaudeQuota(connection, usage);
      })()]);
    } catch {
      // Failed reads do not establish recovery and never remove locks.
    } finally { entry.pending = false; }
  })();
  checks.set(connection.id, entry);
  return entry.promise;
}

export async function recoverClaudeQuotaForSelection(model, excluded) {
  const connections = (await getProviderConnections({ provider: "claude", isActive: true }))
    .filter(connection => !excluded.has(connection.id));
  const relevant = connection => activeLocks(connection).some(key => key === MODEL_LOCK_ALL || key === `${MODEL_LOCK_PREFIX}${model}`);
  const work = Promise.all(connections.filter(connection => connection.accessToken && relevant(connection))
    .map(connection => refreshClaudeQuota(connection)));
  if (connections.every(relevant)) await work;
  else void work.catch(() => {}); // Restore reset accounts without delaying healthy traffic.
}
