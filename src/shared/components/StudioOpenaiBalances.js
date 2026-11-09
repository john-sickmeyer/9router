"use client";

import { useEffect, useRef, useState } from "react";

const usd = value => (value < 0 ? "−$" : "$") + Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const post = async body => {
  const response = await fetch("/api/studio/openai-pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
};

function GrantEditor({ account, balance, onSaved, setMessage }) {
  const [rows, setRows] = useState(() => (balance.grants?.length ? balance.grants : [{ amountUsd: "", grantedOn: "", expiresOn: "" }])
    .map(g => ({ amountUsd: String(g.amountUsd ?? ""), grantedOn: g.grantedOn || "", expiresOn: g.expiresOn || "" })));
  const [busy, setBusy] = useState(false);
  const update = (i, field, value) => setRows(rows.map((row, j) => j === i ? { ...row, [field]: value } : row));
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const grants = rows.filter(r => r.amountUsd || r.grantedOn).map(r => ({ amountUsd: Number(r.amountUsd), grantedOn: r.grantedOn, expiresOn: r.expiresOn || null }));
      await post({ action: "set-grants", connectionId: account.id, grants });
      setMessage(`Grants saved for ${account.name}.`);
      await onSaved();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  const input = "border border-border bg-transparent rounded px-2 py-1 w-full";
  return <form onSubmit={save} className="space-y-2" aria-label={`Credit grants for ${account.name}`}>
    {rows.map((row, i) => <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
      <label className="text-xs">Amount (USD)<input aria-label="Grant amount in USD" className={input} type="number" min="0.01" step="0.01" value={row.amountUsd} onChange={e => update(i, "amountUsd", e.target.value)} /></label>
      <label className="text-xs">Granted on<input aria-label="Grant date" className={input} type="date" value={row.grantedOn} onChange={e => update(i, "grantedOn", e.target.value)} /></label>
      <label className="text-xs">Expires (optional)<input aria-label="Grant expiry date" className={input} type="date" value={row.expiresOn} onChange={e => update(i, "expiresOn", e.target.value)} /></label>
      <button type="button" className="text-xs border border-border rounded px-2 py-1" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ amountUsd: "", grantedOn: "", expiresOn: "" }])}>Remove</button>
    </div>)}
    <div className="flex gap-2">
      <button type="button" className="text-sm border border-border rounded px-3 py-1" onClick={() => setRows([...rows, { amountUsd: "", grantedOn: "", expiresOn: "" }])}>Add grant</button>
      <button type="submit" disabled={busy} className="text-sm border border-border rounded px-3 py-1 disabled:opacity-50">{busy ? "Saving…" : "Save grants"}</button>
    </div>
  </form>;
}

function AccountBalance({ account, balance, reload, setMessage }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);
  async function run(label, body, done) {
    setBusy(label);
    try { await post(body); setMessage(done); await reload(); return true; }
    catch (error) { setMessage(error.message); return false; }
    finally { setBusy(null); }
  }
  const status = account.billing?.status === "blocked" ? "OpenAI is refusing requests (billing)" : account.isActive ? "Active" : "Paused";
  return <div className="border-t border-border pt-3 space-y-2" aria-label={`OpenAI balance for ${account.name}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="font-medium">{account.name || "OpenAI API account"} <span className="text-sm text-text-muted">· {status}</span></p>
      {balance?.configured && <p className={`font-semibold ${balance.overdrawn ? "text-red-500" : ""}`}>
        {balance.remainingUsd === null ? (balance.grants?.length ? "Balance not read yet" : "Add grants to see the balance") : `${usd(balance.remainingUsd)} ${balance.overdrawn ? "overdrawn" : "remaining"}`}
      </p>}
    </div>
    {!balance?.configured && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); run("key", { action: "set-admin-key", connectionId: account.id, adminKey: key }, `Admin key saved and verified for ${account.name}.`).then(ok => { if (ok) setKey(""); }); }}>
      <label className="text-sm flex-1 min-w-[16rem]">Admin key for this account’s OpenAI organization
        <input aria-label={`Admin key for ${account.name}`} type="password" autoComplete="off" spellCheck={false} placeholder="sk-admin-…" value={key} onChange={e => setKey(e.target.value)} className="block w-full border border-border bg-transparent rounded px-3 py-2 mt-1" />
      </label>
      <button type="submit" disabled={!key || busy !== null} className="border border-border rounded px-4 py-2 disabled:opacity-50">{busy === "key" ? "Verifying…" : "Save admin key"}</button>
    </form>}
    {balance?.configured && <>
      <p className="text-sm text-text-muted">
        {balance.grants.length ? `${usd(balance.grantsUsd)} in grants` : "No grants recorded"}
        {balance.billedUsd !== null && ` · ${usd(balance.billedUsd)} billed by OpenAI since ${new Date(balance.billingStart || balance.addedAt).toLocaleDateString(undefined, { timeZone: "UTC" })}`}
        {balance.readAt && ` · read ${new Date(balance.readAt).toLocaleString()}`}
        {` · 9Router recorded ${usd(balance.local.costUsd)} over ${balance.local.requests.toLocaleString()} requests`}
      </p>
      {balance.organizationMatch === false && <p className="text-sm text-amber-600" role="alert">This admin key’s organization does not list this connection’s API key. Check that the admin key belongs to the same OpenAI account.</p>}
      {balance.inferenceKeyChanged && <p className="text-sm text-amber-600" role="alert">This connection’s API key changed after the admin key was added. Re-enter the admin key if the account’s organization changed.</p>}
      {balance.expiredUsd > 0 && <p className="text-sm text-amber-600">{usd(balance.expiredUsd)} of these grants has passed its expiry date. OpenAI decides how expired credit applies, so it is still counted above.</p>}
      {!balance.readComplete && <p className="text-sm text-amber-600">OpenAI returned more cost pages than were read; the billed total may be low.</p>}
      {balance.error && <p className="text-sm text-red-500" role="alert">{balance.error.message} ({new Date(balance.error.at).toLocaleString()})</p>}
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-text-muted self-center">Admin key {balance.keyHint}</span>
        <button className="border border-border rounded px-3 py-1" onClick={() => setEditing(!editing)}>{editing ? "Close grants" : "Edit grants"}</button>
        <button className="border border-border rounded px-3 py-1 disabled:opacity-50" disabled={busy !== null} onClick={() => run("remove", { action: "remove-admin-key", connectionId: account.id }, `Admin key removed for ${account.name}.`)}>{busy === "remove" ? "Removing…" : "Remove admin key"}</button>
      </div>
      {editing && <GrantEditor account={account} balance={balance} setMessage={setMessage} onSaved={async () => { setEditing(false); await reload(); }} />}
    </>}
  </div>;
}

export default function StudioOpenaiBalances({ pool, reload }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshed = useRef(false);
  const accounts = pool?.allAccounts || [];
  const balances = pool?.balances || {};
  const anyStale = accounts.some(a => balances[a.id]?.configured && balances[a.id].stale);
  // One free Costs API read per page visit for balances older than 15 minutes; the 10-second poll only reads the cache.
  useEffect(() => {
    if (!anyStale || refreshed.current) return;
    refreshed.current = true;
    post({ action: "refresh-balances" }).then(() => reload()).catch(() => {});
  }, [anyStale, reload]);
  if (!accounts.length) return null;
  const configured = accounts.filter(a => balances[a.id]?.configured);
  const tracked = configured.filter(a => balances[a.id].remainingUsd !== null);
  const totals = tracked.reduce((t, a) => { const b = balances[a.id]; return { grants: t.grants + b.grantsUsd, billed: t.billed + b.billedUsd }; }, { grants: 0, billed: 0 });
  async function refresh() {
    setBusy(true);
    try { await post({ action: "refresh-balances", force: true }); setMessage("Balances refreshed from OpenAI."); await reload(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <section className="border border-border rounded-xl p-5 space-y-3" aria-label="OpenAI API grant balances">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-semibold">OpenAI API grant balances</h2>
      {configured.length > 0 && <button disabled={busy} onClick={refresh} className="border border-border rounded px-4 py-2 disabled:opacity-50">{busy ? "Refreshing…" : "Refresh balances"}</button>}
    </div>
    <p className="text-sm text-text-muted">Each OpenAI account is a separate organization. Add that organization’s admin key and the grants you received. The balance is your grants minus what OpenAI has billed since the first grant. OpenAI does not let admin keys read grant balances, so the grants come from you. Reading costs is free and does not use credit. Routing is unchanged: accounts keep running until OpenAI refuses requests.</p>
    {tracked.length > 0 && <p className="font-semibold">{tracked.length} of {accounts.length} accounts tracked · {usd(totals.grants)} granted · {usd(totals.billed)} billed · {usd(totals.grants - totals.billed)} {totals.grants - totals.billed < 0 ? "overdrawn" : "remaining"}</p>}
    {accounts.map(account => <AccountBalance key={account.id} account={account} balance={balances[account.id]} reload={reload} setMessage={setMessage} />)}
    <p role="status" className="text-sm">{message}</p>
  </section>;
}
