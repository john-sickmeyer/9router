"use client";

import { useState, useEffect, useCallback } from "react";

export default function StudioControls() {
  const [data, setData] = useState(null);
  const [model, setModel] = useState("cx/gpt-6-astra");
  const [speed, setSpeed] = useState("standard");
  const [effort, setEffort] = useState("high");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch("/api/studio");
    if (!res.ok) throw new Error(`Cannot load controls (${res.status})`);
    setData(await res.json());
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => load().catch(e => setMessage(e.message)), 0);
    const timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 10000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  const choice = data?.choices.find(c => c.id === model);
  const alias = `${model}@${speed}${effort === "client" ? "" : `(${effort})`}`;
  async function refresh() {
    setBusy(true); setMessage("Refreshing account capabilities…");
    try {
      const res = await fetch("/api/studio", { method: "POST" });
      if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
      const body = await res.json();
      const failures = body.results.filter(r => !r.ok).length;
      setMessage(failures ? `${failures} account refreshes failed. See the account timestamps below.` : "Account capabilities refreshed.");
      await load();
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }
  const selectClass = "rounded-lg border border-border bg-bg p-3 w-full";
  return <main className="max-w-6xl mx-auto p-6 space-y-7">
    <div><h1 className="text-2xl font-semibold">Studio controls</h1><p className="text-text-muted mt-2">Choose a speed and effort, then use the exact model name in your AI client. Account switching preserves both choices.</p></div>
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div className="grid md:grid-cols-3 gap-4">
        <label>Model<select className={selectClass} value={model} onChange={e => { const c = data.choices.find(x => x.id === e.target.value); setModel(c.id); setSpeed("standard"); setEffort(effort === "client" || c.efforts.includes(effort) ? effort : "high"); }}>{data?.choices.map(c => <option key={c.id}>{c.id}</option>)}</select></label>
        <label>Speed<select className={selectClass} value={speed} onChange={e => setSpeed(e.target.value)}>{(choice?.speeds || ["standard"]).map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Effort<select className={selectClass} value={effort} onChange={e => setEffort(e.target.value)}><option value="client">Use client’s effort</option>{(choice?.efforts || ["high"]).map(e => <option key={e}>{e}</option>)}</select></label>
      </div>
      <div className="flex flex-wrap gap-3 items-center"><code className="bg-bg-subtle p-3 rounded break-all">{alias}</code><button className="border border-border rounded px-4 py-2" onClick={async () => { try { await navigator.clipboard.writeText(alias); setMessage("Model name copied."); } catch { setMessage("Select and copy the model name above."); } }}>Copy model name</button></div>
      <p className="text-sm text-text-muted">If your client sends an explicit effort too, use the same value. Conflicting choices return an error. Claude Fast requires provider eligibility and usage credits; a successful connection alone does not confirm Fast.</p>
      <p className="text-sm text-amber-600">Codex can report “default” even when accelerated requests run faster. Such requests are marked unconfirmed below: the selected controls were sent, but the provider did not confirm the served or billed tier.</p>
    </section>
    <section className="space-y-3">
      <div className="flex gap-4 items-center"><h2 className="text-xl font-semibold">Accounts</h2><button disabled={busy} onClick={refresh} className="border border-border rounded px-4 py-2 disabled:opacity-50">{busy ? "Refreshing…" : "Refresh capabilities"}</button></div>
      <p role="status">{message}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr><th className="p-2">Account</th><th>Provider plan</th><th>Speed eligibility</th><th>Last checked</th></tr></thead><tbody>{data?.accounts.map(a => <tr className="border-t border-border" key={a.id}><td className="p-2">{a.name}</td><td>{a.provider} · {a.plan || "provider managed"}</td><td>{a.provider === "claude" ? "Confirmed per response" : a.stale ? "Refresh needed" : a.ultrafast ? "Standard / Fast / Ultrafast" : "Standard / Fast"}</td><td>{a.checkedAt ? new Date(a.checkedAt).toLocaleString() : "—"}</td></tr>)}</tbody></table></div>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Recent request checks</h2><p className="text-sm text-text-muted">“Sent” is the final provider request. “Reported” is the provider response. An absent reported effort means the provider did not echo it. Prompts and credentials are excluded from this log.</p>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr><th className="p-2">Time / request</th><th>Account / model</th><th>State</th><th>Sent speed / effort</th><th>Reported speed / effort</th></tr></thead><tbody>{[...(data?.recent || [])].reverse().slice(0, 40).map((r, i) => <tr className="border-t border-border" key={`${r.requestId}-${i}`}><td className="p-2">{new Date(r.time).toLocaleTimeString()}<br/><code>{r.requestId.slice(0, 8)}</code></td><td>{data?.accounts.find(a => a.id === r.connectionId)?.name || r.connectionId.slice(0, 8)}<br/>{r.model}</td><td>{r.state}{r.error && <p className="text-red-500">{r.error}</p>}{r.warning && <p className="text-amber-600" title={r.warning}>Served speed unconfirmed</p>}</td><td>{r.sentTier || "—"} / {r.sentEffort || "—"}</td><td>{r.reportedTier || "—"} / {r.reportedEffort || "—"}</td></tr>)}</tbody></table></div>
    </section>
    <p className="text-sm text-text-muted">Release: {data?.release || "loading"}. Updates use the fork’s staged Git release process in STUDIO.md.</p>
  </main>;
}
