import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, request } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTransportTracker } from "../../scripts/studio-transport.cjs";

vi.mock("../../src/lib/dataDir.js", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { DATA_DIR: mkdtempSync(join(tmpdir(), "studio-transport-test-")) };
});
import { DATA_DIR } from "../../src/lib/dataDir.js";
import { controlStatus, recordControl } from "../../src/lib/studio/audit.js";

const transportKey = Symbol.for("9router.studio.transport");
const auditKey = Symbol.for("9router.studio.audit");
let tracker, server;
beforeEach(() => {
  tracker = globalThis[transportKey] = createTransportTracker();
  globalThis[auditKey].pending.clear();
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
  await controlStatus();
  delete globalThis[transportKey];
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

async function serve(handler) {
  server = createServer((req, res) => tracker.handle(req, res, handler));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe("Studio HTTP drain lifecycle", () => {
  it("keeps a response active after provider completion until its body finishes", async () => {
    let finish;
    const url = await serve(async (_req, res) => {
      await recordControl({ requestId: "complete", connectionId: "account", state: "started" });
      await recordControl({ requestId: "complete", connectionId: "account", state: "completed" });
      finish = () => res.end("done");
      res.write("data: provider complete\n\n");
    });
    const response = await fetch(url + "/v1/responses", { method: "POST" });
    expect((await controlStatus()).pending).toEqual([]);
    expect(tracker.snapshot().activeCount).toBe(1);
    finish();
    await response.text();
    expect(tracker.snapshot().activeCount).toBe(0);
  });

  it("closes an orphaned audit entry on HTTP finish", async () => {
    const url = await serve(async (_req, res) => {
      await recordControl({ requestId: "orphan", connectionId: "account", state: "started" });
      res.end("finished without provider terminal");
    });
    await (await fetch(url + "/responses", { method: "POST" })).text();
    const status = await controlStatus();
    expect(status.pending).toEqual([]);
    expect(status.recent.at(-1)).toMatchObject({ requestId: "orphan", state: "failed" });
    expect(status.transport.activeCount).toBe(0);
  });

  it("cancels disconnected requests and ignores delayed outbound callbacks for draining", async () => {
    let late;
    const url = await serve(async (_req, res) => {
      await recordControl({ requestId: "aborted", connectionId: "account", state: "started" });
      late = AsyncLocalStorage.bind(() => recordControl({ requestId: "aborted", connectionId: "account", state: "outbound" }));
      res.write("data: pending\n\n");
    });
    await new Promise((resolve, reject) => {
      const req = request(url + "/codex/responses", { method: "POST" }, res => {
        res.once("data", () => { res.destroy(); resolve(); });
      });
      req.on("error", reject);
      req.end();
    });
    await vi.waitFor(() => expect(tracker.snapshot().activeCount).toBe(0));
    expect((await controlStatus()).recent.at(-1)).toMatchObject({ requestId: "aborted", state: "cancelled" });
    await late();
    expect((await controlStatus()).pending).toEqual([]);
  });

  it("tracks uploads before their body is complete", async () => {
    const url = await serve((req, res) => {
      req.on("end", () => res.end("done"));
      req.resume();
    });
    const req = request(url + "/v1/images/generations", { method: "POST", headers: { "content-length": "4" } });
    req.on("error", () => {});
    req.flushHeaders();
    try {
      await vi.waitFor(() => expect(tracker.snapshot().activeCount).toBe(1));
      req.destroy();
      await vi.waitFor(() => expect(tracker.snapshot().activeCount).toBe(0));
    } finally { req.destroy(); }
  });

  it.each(["/v1/chat/completions", "/api/v1/messages", "/v1/v1/responses", "/responses",
    "/codex/responses", "/systemone", "/v1/images/generations", "/v1/embeddings",
    "/v1beta/models/test:generateContent", "/api/v1beta/models/test:generateContent"])
  ("rejects new inference at %s during maintenance", async path => {
    const marker = join(DATA_DIR, "maintenance");
    writeFileSync(marker, "draining");
    vi.stubEnv("STUDIO_MAINTENANCE_FILE", marker);
    const handler = vi.fn((_req, res) => res.end("unexpected"));
    const url = await serve(handler);
    const response = await fetch(url + path, { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await response.text();
    expect(handler).not.toHaveBeenCalled();
    expect(tracker.snapshot().activeCount).toBe(0);
  });

  it("keeps health and catalog reads available during maintenance", async () => {
    const marker = join(DATA_DIR, "maintenance");
    writeFileSync(marker, "draining");
    vi.stubEnv("STUDIO_MAINTENANCE_FILE", marker);
    const url = await serve((_req, res) => res.end("ok"));
    for (const path of ["/api/studio", "/v1/models", "/api/v1/models"]) {
      expect(await (await fetch(url + path)).text()).toBe("ok");
    }
    expect(tracker.snapshot().activeCount).toBe(0);
  });
});
