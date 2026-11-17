import { createHash } from "node:crypto";
import { CODEX_TURN_STATE_HEADER } from "../config/studioControls.js";
import { extractClientSessionId } from "../utils/sessionManager.js";

// Keep ownership across Next route modules in the same worker. An unrecognized
// marker (including one from before a restart) starts with ordinary routing.
const routes = globalThis[Symbol.for("9router.codexTurnRoutes")] ??= new Map();
const MAX_ROUTES = 5000;

function remember(key, route) {
  const current = routes.get(key);
  if (sameOwner(current, route.connectionId, route.accountId) && current.state === route.state) route = current;
  routes.delete(key);
  routes.set(key, route);
  if (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value);
}

function sameOwner(route, connectionId, accountId) {
  return Boolean(route && route.connectionId === connectionId && route.accountId === accountId);
}

export function createCodexTurnRoute(headers, body, apiKey) {
  // A per-request ID can change between tool calls within one turn.
  const session = extractClientSessionId(Object.fromEntries(headers), body, "codex", false);
  let turnId = null;
  const metadata = headers.get("x-codex-turn-metadata");
  if (metadata) {
    try { turnId = JSON.parse(metadata)?.turn_id ?? null; } catch { /* Optional client metadata. */ }
  }
  const keyFor = state => createHash("sha256").update(JSON.stringify([apiKey || null, session, turnId, state])).digest("hex");
  const incoming = headers.get(CODEX_TURN_STATE_HEADER);
  const key = incoming && keyFor(incoming);
  const previous = key && routes.get(key);
  let attempt;
  let responseState;

  return {
    preferredConnectionId: previous?.connectionId,
    forRequest(connectionId, accountId) {
      if (sameOwner(previous, connectionId, accountId)) return previous.state;
      return sameOwner(attempt, connectionId, accountId) ? attempt.state : null;
    },
    observe(connectionId, accountId, state) {
      if (!connectionId || !accountId) {
        attempt = undefined;
        responseState = null;
        return;
      }
      if (!sameOwner(attempt, connectionId, accountId)) attempt = { connectionId, accountId, state: null };
      // The native client keeps the first marker for retries within a turn.
      attempt.state ||= state;
      responseState = state || attempt.state;
    },
    forwardTo(responseHeaders, connectionId) {
      if (!connectionId || attempt?.connectionId !== connectionId) return;
      const next = responseState && { connectionId, accountId: attempt.accountId, state: responseState };
      if (next) {
        const returnedKey = keyFor(responseState);
        // An older overlapping call must not reclaim a marker after failover.
        if (returnedKey !== key || !previous || routes.get(key) === previous) remember(returnedKey, next);
        responseHeaders.set(CODEX_TURN_STATE_HEADER, responseState);
        responseHeaders.append("access-control-expose-headers", CODEX_TURN_STATE_HEADER);
      }
      // A native client can keep echoing its first marker even after the router
      // changes accounts. Only the new owner's own marker may go to that owner.
      if (previous && !sameOwner(previous, connectionId, attempt.accountId) && routes.get(key) === previous) {
        if (next) remember(key, next);
        else routes.delete(key);
      }
    },
  };
}
