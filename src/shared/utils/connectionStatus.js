export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "rate limited" || effectiveStatus === "retry ready") return "warning";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

export function getConnectionHealth(connection, now = Date.now()) {
  if (connection.provider === "openai" && connection.studioBillingState?.status === "blocked") return { status: "unavailable", retryAfter: null };
  const expiries = Object.entries(connection)
    .filter(([key, value]) => key.startsWith("modelLock_") && Date.parse(value) > now)
    .map(([, value]) => value).sort();
  const global = connection.modelLock___all;
  const retryAfter = Date.parse(global) > now ? global : expiries[0] || null;
  const status = retryAfter
    ? Number(connection.errorCode) === 429 ? "rate limited" : "unavailable"
    : connection.testStatus === "unavailable" ? "retry ready" : connection.testStatus;
  return { status, retryAfter };
}

/**
 * Identify providers that have connections configured, but ALL of them are deactivated (isActive === false).
 * Providers with 0 connections (e.g. keyless local nodes) are NOT considered deactivated.
 * @param {Array<{provider: string, isActive?: boolean}>} connections
 * @returns {Set<string>} Set of deactivated provider IDs
 */
export function getDeactivatedProviderIds(connections) {
  const byProvider = {};
  for (const c of connections || []) {
    if (!c?.provider) continue;
    if (!byProvider[c.provider]) byProvider[c.provider] = { total: 0, active: 0 };
    byProvider[c.provider].total += 1;
    if (c.isActive !== false) byProvider[c.provider].active += 1;
  }
  const deactivated = new Set();
  for (const [provider, stats] of Object.entries(byProvider)) {
    if (stats.total > 0 && stats.active === 0) {
      deactivated.add(provider);
    }
  }
  return deactivated;
}
