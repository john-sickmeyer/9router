"use client";

import { useState } from "react";

export default function StudioOpenaiPool({ pool, reload }) {
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");
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
  return <section className="border border-border rounded-xl p-5 space-y-3" aria-label="OpenAI account pool">
    <h2 className="text-xl font-semibold">OpenAI API first, then Codex OAuth</h2>
    <p className="text-sm text-text-muted">The existing Happier model choices use API credits first. If the API cannot serve the selected model, speed and effort, eligible OAuth accounts take over. Proxy Pools configure network connections; they are not needed for account routing.</p>
    <p className="text-sm text-text-muted">Credit balance and expiration are unknown. Actual inference confirms capacity. Billing failures stay suspended until you retry the account here after restoring credits or limits. Auto Recharge and billing settings are managed in OpenAI.</p>
    {pool.metadataStale && <p className="text-amber-600" role="alert">Model and speed metadata needs review. Last reviewed: {pool.metadataReviewedAt}.</p>}
    {!pool.accounts.length && <p className="text-amber-600">No active API account. Requests use Codex OAuth.</p>}
    {pool.accounts.map(account => <div key={account.id} className="border-t border-border pt-3 flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-medium">{account.name || "OpenAI API account"}</p>
        <p className="text-sm">{account.billing?.status === "blocked" ? `Billing suspended: ${account.billing.code}`
          : account.billing?.status === "retry" ? "Recovery pending: one request will test API capacity"
          : "API first; capacity checked on each request"}</p>
        <p className="text-sm text-text-muted">Model availability: {account.catalogStale ? "refresh needed" : "current"}{account.checkedAt ? ` (${new Date(account.checkedAt).toLocaleString()})` : ""}. Availability does not confirm credits or speed eligibility.</p>
      </div>
      {account.billing?.status === "blocked" && <button className="border border-border rounded px-4 py-2 disabled:opacity-50" disabled={busy !== null} onClick={() => retry(account.id)}>{busy === account.id ? "Reopening..." : "Retry API after restoring credits"}</button>}
    </div>)}
    <p role="status">{message}</p>
  </section>;
}
