"use client";

const rate = sample => Number.isFinite(sample?.tps) ? `${sample.tps.toFixed(1)} TPS` : sample?.reason || "—";
const localTime = stamp => stamp ? new Date(stamp).toLocaleTimeString() : "—";

export default function StudioUltrafastHealth({ health, accounts }) {
  if (!health?.enabled) return null;
  return <section className="space-y-3"><h2 className="text-xl font-semibold">Ultrafast delivery</h2>
    <p className="text-sm text-text-muted">{health.mode === "enforce" ? "Only recently qualified accounts serve Ultrafast." : "Observing existing traffic while accounts are tested."} Two independent GPT-6.2 Sol Light Ultrafast pings at {health.bands.fastMin} TPS or faster qualify an account. Two pings at {health.bands.slowMax} TPS or slower suspend it. Recovery is automatic.</p>
    <div className="overflow-x-auto"><table className="w-full text-sm text-left">
      <thead><tr><th className="p-2">Account</th><th>Routing status</th><th>Latest qualifying-size live samples</th><th>Last recovery ping</th><th>Next ping</th></tr></thead>
      <tbody>{health.rows.map(row => <tr className="border-t border-border" key={row.connectionId}>
        <td className="p-2">{accounts.find(a => a.id === row.connectionId)?.name || row.connectionId.slice(0,8)}<br/>{row.provider}</td>
        <td>{health.reserves?.[row.connectionId]?.held ? "Held at 1% quota reserve" : row.eligible ? "Qualified" : row.status === "qualified" ? row.speedEligible ? "Awaiting quota" : "Expired" : row.status}</td>
        <td>{Object.values(row.liveByModel || {}).map(s => <p key={s.model}>{s.model} · {rate(s)} · {localTime(s.at)}</p>)}</td>
        <td>{rate(row.lastProbe)}<br/>{localTime(row.lastProbe?.at)}</td>
        <td>{row.probing ? "Testing now" : row.activeRequests?.length && row.nextProbe <= Date.now() ? "After live traffic" : localTime(row.nextProbe)}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
