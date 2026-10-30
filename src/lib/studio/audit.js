import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const stateKey = Symbol.for("9router.studio.audit");
const state = globalThis[stateKey] ||= { pending: new Map(), queue: Promise.resolve() };
const file = path.join(DATA_DIR, "studio-controls.jsonl");

state.onTransportClosed = (transportRequestId, reason) => {
  for (const entry of state.pending.values()) {
    if (entry.transportRequestId !== transportRequestId) continue;
    void recordControl({ ...entry, time: new Date().toISOString(),
      state: reason === "closed" ? "cancelled" : "failed",
      error: "HTTP response ended before a provider completion was observed" });
  }
};

export function isControlDraining() {
  return Boolean(process.env.STUDIO_MAINTENANCE_FILE && existsSync(process.env.STUDIO_MAINTENANCE_FILE));
}

export async function recordControl(event) {
  const transport = globalThis[Symbol.for("9router.studio.transport")];
  const transportRequestId = transport?.scope.getStore()?.requestId;
  const entry = { time: new Date().toISOString(), ...(transportRequestId ? { transportRequestId } : {}), ...event };
  const key = `${entry.requestId}:${entry.connectionId}`;
  if (["started", "outbound"].includes(entry.state)) {
    // A slow upstream callback can arrive after the client socket has closed.
    if (!entry.transportRequestId || transport?.active.has(entry.transportRequestId)) state.pending.set(key, entry);
  }
  else if (["completed", "failed", "cancelled", "bypassed"].includes(entry.state)) state.pending.delete(key);
  const write = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.size > 5 * 1024 * 1024) await fs.rename(file, `${file}.1`);
    await fs.appendFile(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  };
  state.queue = state.queue.then(write, write).catch(() => console.error("[Studio] Could not persist control audit"));
  await state.queue;
}

export async function controlStatus() {
  await state.queue;
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const transport = globalThis[Symbol.for("9router.studio.transport")];
  return { pending: [...state.pending.values()],
    ...(transport ? { transport: transport.snapshot() } : {}),
    recent: text.trim().split("\n").filter(Boolean).slice(-100).map(line => JSON.parse(line)) };
}
