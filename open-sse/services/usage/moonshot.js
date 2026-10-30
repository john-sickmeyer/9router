import { MOONSHOT_BALANCE_URL, MOONSHOT_TIMEOUT_MS } from "../../config/moonshot.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export async function getMoonshotUsage(apiKey, proxyOptions = null) {
  const plan = "Kimi API Platform";
  if (typeof apiKey !== "string" || !apiKey.trim()) return { plan, message: "API key not available" };
  try {
    const response = await proxyAwareFetch(MOONSHOT_BALANCE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(MOONSHOT_TIMEOUT_MS),
      redirect: "error",
    }, proxyOptions);
    if (!response.ok) return { plan, message: `Balance lookup failed (HTTP ${response.status})` };
    const payload = await response.json();
    const rawBalance = payload?.data?.available_balance;
    const balance = Number(rawBalance);
    if (payload?.code !== 0 || payload?.status !== true
      || !["number", "string"].includes(typeof rawBalance)
      || String(rawBalance).trim() === "" || !Number.isFinite(balance)) {
      return { plan, message: "Unexpected balance response from Kimi API Platform" };
    }
    const total = Math.max(0, balance);
    return {
      plan,
      quotas: {
        "Balance (USD)": {
          used: 0, total, remainingPercentage: total > 0 ? 100 : 0,
          resetAt: null, unlimited: false, isCreditBalance: true, currency: "USD",
        },
      },
    };
  } catch {
    return { plan, message: "Unable to fetch Kimi API Platform balance" };
  }
}
