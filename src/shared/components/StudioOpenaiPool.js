"use client";

import { useState } from "react";

export default function StudioOpenaiPool({ pool, reload }) {
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");
  const [balance, setBalance] = useState("");
  if (!pool?.enabled) return null;
  async function retry(connectionId) {
    setBusy(connectionId);
    try {
      const response = await fetch("/api/studio/openai-pool", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry-billing", connectionId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not reopen API account");
      setMessage(result.message);
      await reload();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  async function saveBalance(event) {
    event.preventDefault();
    setBusy("balance");
    try {
      const response = await fetch("/api/studio/openai-pool", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set-credit-balance",
          balanceUsd: Number(balance), connectionIds: pool.credit?.connectionIds || pool.accounts.map(a => a.id) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save balance");
      setBalance(""); setMessage("Balance checkpoint saved. Subsequent API costs will be deducted automatically.");
      await reload();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  return <section className="border border-border rounded-xl p-5 space-y-3" aria-label="OpenAI account pool">
    <h2 className="text-xl font-semibold">OpenAI API first, then Codex OAuth</h2>
    <p className="text-sm text-text-muted">The existing Happier model choices use API credits first. If the API cannot serve the selected model, speed and effort, eligible OAuth accounts take over. Proxy Pools configure network connections; they are not needed for account routing.</p>
    <p className="text-sm text-text-muted">Recorded API token costs reduce the estimated credit balance. At zero, requests use OAuth automatically without repeated API probes. An actual billing error can trigger fallback sooner. OpenAI manages Auto Recharge and credit expiration.</p>
    {pool.credit && <div className="border border-border rounded-lg p-3 space-y-1" aria-label="OpenAI estimated credit balance">
      <p className="font-semibold">Estimated credit remaining: ${pool.credit.remainingUsd.toFixed(2)}</p>
      <p className="text-sm text-text-muted">${pool.credit.spentUsd.toFixed(2)} recorded since the ${pool.credit.balanceUsd.toFixed(2)} checkpoint on {new Date(pool.credit.recordedAt).toLocaleString()}.</p>
      <p className="text-sm">{pool.credit.exhausted ? "Estimated credits exhausted — new requests use eligible OAuth accounts." : "Using API credits first."}</p>
      {pool.credit.unpricedRequests > 0 && <p className="text-amber-600" role="alert">{pool.credit.unpricedRequests} request(s) could not be priced. The estimate may overstate remaining credit.</p>}
    </div>}
    {!pool.credit && <p className="text-sm text-text-muted">No balance checkpoint saved yet. API-first routing currently relies on actual billing responses.</p>}
    <form onSubmit={saveBalance} className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Current OpenAI balance (USD)
        <input aria-label="Current OpenAI balance in USD" type="number" min="0" step="0.01" required value={balance} onChange={event => setBalance(event.target.value)} className="block border border-border bg-transparent rounded px-3 py-2 mt-1" />
      </label>
      <button type="submit" className="border border-border rounded px-4 py-2 disabled:opacity-50" disabled={busy !== null || !balance || !pool.accounts.length}>{busy === "balance" ? "Saving..." : "Save balance checkpoint"}</button>
    </form>
    <p className="text-sm text-text-muted">This is a local estimate for the OpenAI accounts sharing this balance. It cannot see top-ups, expiration, missing usage, or billing adjustments. After adding credits, save the new balance here; no separate reset is needed.</p>
    {pool.metadataStale && <p className="text-amber-600" role="alert">Model and speed metadata needs review. Last reviewed: {pool.metadataReviewedAt}.</p>}
    {!pool.accounts.length && <p className="text-amber-600">No active API account. Requests use Codex OAuth.</p>}
    {pool.accounts.map(account => <div key={account.id} className="border-t border-border pt-3 flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-medium">{account.name || "OpenAI API account"}</p>
        <p className="text-sm">{account.billing?.status === "blocked" ? `Billing suspended: ${account.billing.code}`
          : account.billing?.status === "retry" ? "Recovery pending: one request will test API capacity"
          : pool.credit?.exhausted && pool.credit.connectionIds.includes(account.id) ? "Estimated credits exhausted; using OAuth"
          : "API first; spending tracked from request usage"}</p>
        <p className="text-sm text-text-muted">Model availability: {account.catalogStale ? "refresh needed" : "current"}{account.checkedAt ? ` (${new Date(account.checkedAt).toLocaleString()})` : ""}. Availability does not confirm credits or speed eligibility.</p>
      </div>
      {account.billing?.status === "blocked" && <button className="border border-border rounded px-4 py-2 disabled:opacity-50" disabled={busy !== null} onClick={() => retry(account.id)}>{busy === account.id ? "Reopening..." : "Retry API after restoring credits"}</button>}
    </div>)}
    <p role="status">{message}</p>
  </section>;
}
