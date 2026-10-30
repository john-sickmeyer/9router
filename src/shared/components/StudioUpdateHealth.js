"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function StudioUpdateHealth({ details = false }) {
  const [health, setHealth] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/studio/updates", { cache: "no-store" });
        if (!response.ok) throw new Error("Update status unavailable");
        const value = await response.json();
        if (active) { setHealth(value); setUnavailable(false); }
      } catch { if (active) setUnavailable(true); }
    };
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!health?.managed && !unavailable) return null;
  const warning = unavailable || ["warning", "error"].includes(health?.severity) || health?.providerWarnings?.length > 0;
  if (!details && !warning) return null;
  const color = warning ? "border-amber-500/40 bg-amber-500/10" : "border-border bg-bg-subtle";
  return <section aria-label="Automatic update health" role={warning ? "alert" : "status"}
    className={`rounded-xl border p-4 ${color} ${details ? "space-y-3" : "mx-6 mt-4 lg:mx-10"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">{health?.providerWarnings?.length ? "Studio health needs attention" : `Automatic updates${warning ? " need attention" : ""}`}</h2>
      {!details && <Link className="text-sm underline" href="/dashboard/studio">View update details</Link>}
    </div>
    <p className="text-sm mt-1">{unavailable ? "Update status could not be refreshed. The last known check is shown in Studio controls." : health.message}</p>
    {health?.providerWarnings?.map(message => <p className="text-sm mt-1" key={message}>{message}</p>)}
    {details && <>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-text-muted">Latest upstream checked</dt><dd>{health?.upstreamTag || "Unknown"}</dd></div>
        <div><dt className="text-text-muted">Last check</dt><dd>{health?.lastCheck ? new Date(health.lastCheck * 1000).toLocaleString() : "No recorded check"}</dd></div>
        <div><dt className="text-text-muted">Schedule</dt><dd>Hourly, with a 15-minute watchdog</dd></div>
      </dl>
      {health?.error && <p className="text-sm break-words">Last failure: {health.error}</p>}
      {health?.deferredReason && <p className="text-sm break-words">Waiting: {health.deferredReason}</p>}
      {health?.conflicts?.length > 0 && <p className="text-sm break-words">Files needing resolution: {health.conflicts.join(", ")}</p>}
    </>}
  </section>;
}
