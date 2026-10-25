import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const stateKey = Symbol.for("9router.studio.audit");
const state = globalThis[stateKey] ||= { pending: new Map(), queue: Promise.resolve() };
const file = path.join(DATA_DIR, "studio-controls.jsonl");

export function isControlDraining() {
  return Boolean(process.env.STUDIO_MAINTENANCE_FILE && existsSync(process.env.STUDIO_MAINTENANCE_FILE));
}

export async function recordControl(event) {
  const entry = { time: new Date().toISOString(), ...event };
  const key = `${entry.requestId}:${entry.connectionId}`;
  if (entry.state === "outbound") state.pending.set(key, entry);
  else if (["completed", "failed", "cancelled"].includes(entry.state)) state.pending.delete(key);
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
  return { pending: [...state.pending.values()], recent: text.trim().split("\n").filter(Boolean).slice(-100).map(line => JSON.parse(line)) };
}
