"use client";

import { useEffect, useState } from "react";

// One lightweight dashboard read for all cards, independent of upstream quota refreshes.
export function useCodexSpeedHealth(visible) {
  const [result,setResult] = useState(null);
  useEffect(() => {
    if (!visible) return;
    let closed = false, busy = false;
    const controller = new AbortController();
    async function refresh() {
      if (closed || busy || document.hidden) return;
      busy = true;
      try {
        const response = await fetch("/api/studio/ultrafast", { cache:"no-store", signal:controller.signal });
        if (!response.ok) throw new Error("Ultrafast status unavailable");
        const data = await response.json();
        if (!closed) setResult({ ...data, byId:Object.fromEntries((data.rows || []).map(row=>[row.connectionId,row])) });
      } catch { if (!closed) setResult({ unavailable:true }); }
      finally { busy = false; }
    }
    void refresh();
    const timer = setInterval(refresh,5000);
    document.addEventListener("visibilitychange",refresh);
    return () => { closed=true;clearInterval(timer);controller.abort();document.removeEventListener("visibilitychange",refresh); };
  },[visible]);
  return result;
}

const time = value => value ? new Date(value).toLocaleTimeString() : "—";
const tps = value => Number.isFinite(value) ? value.toFixed(1) + " TPS" : "—";
const samplingReason = {
  "mixed-output": "reasoning or tool calls",
  "short-or-buffered": "short or buffered output",
  "consumer-backpressure": "client paused reading",
  "tokenizer-unavailable": "token count unavailable",
};

export default function CodexSpeedHealth({ connection, monitor, onKeepOff, busy }) {
  if (!monitor || (!monitor.enabled && !monitor.unavailable)) return null;
  if (monitor.unavailable) return <p className="px-3 py-2 text-xs text-text-muted">Ultrafast status unavailable</p>;
  const row = monitor.byId[connection.id];
  const reserve = monitor.reserves?.[connection.id];
  const enabled = row?.connectionActive ?? connection.isActive !== false;
  const observe = monitor.mode === "observe";
  const on = enabled && reserve?.routable && (observe || row?.eligible);
  const label = !enabled && !row?.autoOff ? "Manually off" : row?.autoOff ? "Auto-off" : on ? "On" : "Off";
  const reason = !enabled && !row?.autoOff ? null : reserve?.held ? "1% quota reserve" :
    !reserve?.routable ? "awaiting fresh quota" : observe ? "observing" : row?.probing ? "ping in progress" :
    row?.status === "qualified" && !row.speedEligible ? "qualification expired" : row?.status || "awaiting qualification";
  return <div className="border-b border-black/10 px-3 py-2 text-xs dark:border-white/10" aria-label="Ultrafast routing and delivery">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span><span className="font-medium">Ultrafast routing {label}</span>{reason && <span className="text-text-muted"> · {reason}</span>}</span>
      {row?.autoOff && !enabled && <button type="button" disabled={busy} onClick={onKeepOff} className="text-primary underline">Keep off manually</button>}
    </div>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-text-muted">
      <span>Ping reserve <strong className="text-text-primary">1%</strong>{reserve?.held
        ? (reserve.pingAllowed ? " · at cutoff, speed ping funded" : " · routing held, awaiting ping quota")
        : reserve?.routable ? " · above cutoff" : " · awaiting quota"}
        {reserve?.session && ` · 5h ${reserve.session.remaining}% left`}{reserve?.weekly && ` · weekly ${reserve.weekly.remaining}% left`}</span>
      <span>Last measurable live response <strong className="text-text-primary">{tps(row?.lastLive?.tps)}</strong>{row?.lastLive && ` · ${row.lastLive.model} · ${time(row.lastLive.at)}`}</span>
      <span>Sol Light ping <strong className="text-text-primary">{tps(row?.lastProbe?.tps)}</strong>{row?.lastProbe && ` · ${time(row.lastProbe.at)}`}</span>
      {row?.lastProbe?.reason && <span>{row.lastProbe.reason}</span>}
      {row?.lastObservation?.reason && <span>Latest live response · {samplingReason[row.lastObservation.reason] || row.lastObservation.reason}</span>}
      {row && (enabled || row.autoOff) && <span>{reserve?.held && !reserve.pingAllowed ? "Speed ping waits for quota" : row.probing ? "Ping running" :
        row.activeRequests?.length && row.nextProbe <= Date.now() ? "Ping due after live traffic" : "Next ping " + time(row.nextProbe)}</span>}
    </div>
    {row?.activeRequests?.map(request => <div key={request.requestId} className="mt-1" title={request.sessionId || request.requestId}>
      {request.sessionId ? "Session " + request.sessionId.slice(0,8) : "Request " + request.requestId.slice(0,8)} · {request.model} · {request.effort || "default"} · {Number.isFinite(request.delivery?.tps) ? tps(request.delivery.tps) : "Awaiting measurable output"}
    </div>)}
  </div>;
}
