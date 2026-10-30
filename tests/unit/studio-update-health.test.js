import { describe, expect, it } from "vitest";
import { readUpdateHealth, summarizeUpdateHealth } from "../../scripts/studio-update-health.cjs";

const now = 200000;
const healthy = { status: "up-to-date", lastCheck: now - 60, currentRevision: "revision", upstream: { tag: "v0.5.112" } };
const summarize = (state, options = {}) => summarizeUpdateHealth(state, { now, revision: "revision", ...options });

describe("Studio automatic update health", () => {
  it("reports healthy only for a recent check of the live revision", () => {
    expect(summarize(healthy)).toMatchObject({ status: "up-to-date", severity: "ok", needsAttention: false });
    expect(summarize(healthy, { revision: "other" }).needsAttention).toBe(true);
  });
  it.each([null, {}, { ...healthy, lastCheck: now - 10801 }, { ...healthy, lastCheck: now + 301 }])
  ("detects missing, stale, and invalid scheduler timestamps", state => {
    expect(summarize(state)).toMatchObject({ status: "stale", stale: true, needsAttention: true });
  });
  it("retains a merge failure across a temporary deferral", () => {
    expect(summarize({ ...healthy, status: "deferred", deferredReason: "Release lock held",
      lastFailure: { error: "Merge failed", conflicts: ["open-sse/rtk/headroom.js"] } })).toMatchObject({
      status: "needs-resolution", needsAttention: true, error: "Merge failed", deferredReason: "Release lock held",
    });
  });
  it("shows a running retry while retaining the previous failure details", () => {
    expect(summarize({ ...healthy, status: "running", lastFailure: { error: "Earlier conflict", conflicts: ["file.js"] } }))
      .toMatchObject({ status: "running", needsAttention: false, error: "Earlier conflict" });
  });
  it("warns when a validated update is deferred too long", () => {
    expect(summarize({ ...healthy, status: "deferred", deferredSince: now - 60 }).needsAttention).toBe(false);
    expect(summarize({ ...healthy, status: "deferred", deferredSince: now - 21601 }).needsAttention).toBe(true);
  });
  it("respects short maintenance pauses and flags forgotten pauses", () => {
    expect(summarize(healthy, { pausedSince: now - 60 })).toMatchObject({ status: "paused", needsAttention: false });
    expect(summarize(healthy, { pausedSince: now - 7201 })).toMatchObject({ status: "paused", needsAttention: true });
  });
  it("does not expose unrelated state or report an unmanaged install as broken", async () => {
    expect(summarize({ ...healthy, credentials: "fixture-secret" })).not.toHaveProperty("credentials");
    expect(await readUpdateHealth(null)).toEqual({ managed: false });
  });
});
