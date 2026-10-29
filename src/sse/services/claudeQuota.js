import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { QUOTA_LOOKUP_TIMEOUT_MS } from "open-sse/config/errorConfig.js";

export function getClaudeQuotaBlock(usage, model = null, now = Date.now()) {
  const extra = usage?.extraUsage;
  if (extra?.is_enabled && (extra.monthly_limit == null || Number(extra.used_credits) < Number(extra.monthly_limit))) return null;
  const exhausted = Object.entries(usage?.quotas || {}).flatMap(([name, quota]) => {
    const reset = Date.parse(quota.resetAt);
    if (!(quota.remainingPercentage <= 0) || !Number.isFinite(reset) || reset <= now) return [];
    const accountWide = name === "session (5h)" || name === "weekly (7d)";
    const family = /^weekly (.+) \(7d\)$/.exec(name)?.[1];
    if (!accountWide && !(family && model?.toLowerCase().startsWith(`claude-${family}-`))) return [];
    return [{ resetsAtMs: reset, accountWide, name }];
  });
  // Account-wide windows apply to every model. Recheck model-specific limits
  // when those expire instead of extending every model's lock for one family.
  const global = exhausted.filter(quota => quota.accountWide);
  return (global.length ? global : exhausted).sort((a, b) => b.resetsAtMs - a.resetsAtMs)[0] || null;
}

export async function checkClaudeQuota(credentials, model = null) {
  let timer;
  try {
    const usage = await Promise.race([
      getClaudeUsage(credentials.accessToken, credentials.providerSpecificData),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), QUOTA_LOOKUP_TIMEOUT_MS); }),
    ]);
    return getClaudeQuotaBlock(usage, model);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
