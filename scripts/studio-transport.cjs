const { AsyncLocalStorage } = require("node:async_hooks");
const { existsSync } = require("node:fs");
const { randomUUID } = require("node:crypto");

function createTransportTracker() {
  const active = new Map();
  const scope = new AsyncLocalStorage();
  return {
    active,
    scope,
    snapshot() {
      return { version: 1, activeCount: active.size, pending: [...active.values()] };
    },
    handle(req, res, handler) {
      const pathname = (req.url || "").split("?")[0];
      const inference = (/^\/(?:api\/)?v1(?:beta)?(?:\/|$)/.test(pathname)
        || /^\/(?:codex(?:\/|$)|responses\/?$|systemone\/?$)/.test(pathname))
        && req.method !== "OPTIONS" && !(req.method === "GET" && /\/models\/?$/.test(pathname));
      if (!inference) return handler(req, res);
      if (process.env.STUDIO_MAINTENANCE_FILE && existsSync(process.env.STUDIO_MAINTENANCE_FILE)) {
        req.resume();
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { message: "9Router is draining for a Studio update. Retry shortly." } }));
        return;
      }
      const requestId = randomUUID();
      active.set(requestId, { requestId, time: new Date().toISOString(), method: req.method });
      const finish = (reason) => {
        if (!active.delete(requestId)) return;
        globalThis[Symbol.for("9router.studio.audit")]?.onTransportClosed?.(requestId, reason);
      };
      res.once("finish", () => finish("finished"));
      res.once("close", () => finish("closed"));
      return scope.run({ requestId }, () => handler(req, res));
    },
  };
}

module.exports = { createTransportTracker };
