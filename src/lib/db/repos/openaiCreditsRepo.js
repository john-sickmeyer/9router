import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getProviderConnectionById } from "./connectionsRepo.js";

const KEY = "studioOpenaiCredits";

function read(db) {
  return parseJson(db.get("SELECT value FROM _meta WHERE key = ?", [KEY])?.value, null);
}

function write(db, credit) {
  db.run("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [KEY, stringifyJson(credit)]);
}

export async function getOpenaiCreditBalance() {
  const credit = read(await getAdapter());
  if (!credit) return null;
  return { ...credit, remainingUsd: Math.max(0, credit.balanceUsd - credit.spentUsd),
    exhausted: credit.spentUsd >= credit.balanceUsd, estimated: true };
}

export async function setOpenaiCreditBalance({ balanceUsd, connectionIds }) {
  if (typeof balanceUsd !== "number" || !Number.isFinite(balanceUsd) || balanceUsd < 0
      || !Array.isArray(connectionIds) || !connectionIds.length || connectionIds.some(id => typeof id !== "string")) {
    throw new Error("Provide a non-negative USD balance and the OpenAI accounts sharing it");
  }
  const ids = [...new Set(connectionIds)];
  for (const id of ids) {
    if ((await getProviderConnectionById(id))?.provider !== "openai") throw new Error("OpenAI connection not found");
  }
  const db = await getAdapter();
  db.transaction(() => write(db, { balanceUsd, spentUsd: 0, connectionIds: ids,
    recordedAt: new Date().toISOString(), requests: 0, unpricedRequests: 0 }));
  return getOpenaiCreditBalance();
}

// Runs inside the existing usage insertion transaction, after duplicate detection.
// OAuth and keys from other organizations never consume this checkpoint.
export function debitOpenaiCredit(db, entry) {
  if (entry.provider !== "openai") return;
  const credit = read(db);
  if (!credit?.connectionIds.includes(entry.connectionId)) return;
  credit.spentUsd += entry.cost || 0;
  credit.requests += 1;
  if (!entry.cost) credit.unpricedRequests += 1;
  credit.lastUsageAt = entry.timestamp;
  write(db, credit);
}
