const fs = require("node:fs/promises");
const path = require("node:path");

const STALE_SECONDS = 3 * 3600;
const PAUSE_WARNING_SECONDS = 2 * 3600;
const DEFER_WARNING_SECONDS = 6 * 3600;

function summarizeUpdateHealth(state, { now = Date.now() / 1000, pausedSince = null, revision = null } = {}) {
  const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
  const lastCheck = stamp(state?.lastCheck);
  const stale = !lastCheck || now - lastCheck > STALE_SECONDS || lastCheck > now + 300;
  const failure = state?.lastFailure;
  const text = value => typeof value === "string" ? value : null;
  const details = {
    managed: true, lastCheck, stale, upstreamTag: text(state?.upstream?.tag),
    phase: text(state?.phase), revision,
    conflicts: Array.isArray(failure?.conflicts) ? failure.conflicts.filter(value => typeof value === "string") : [],
    error: text(failure?.error) || text(state?.error),
    deferredReason: text(state?.deferredReason),
  };
  const result = (status, severity, message, needsAttention = severity === "warning" || severity === "error") =>
    ({ ...details, status, severity, message, needsAttention });
  if (pausedSince !== null) {
    return result("paused", "warning", "Automatic updates are paused for maintenance.", now - pausedSince > PAUSE_WARNING_SECONDS);
  }
  if (stale) return result("stale", "warning", "No recent update check. The scheduler needs attention.");
  if (state.status === "running") return result("running", "info", "An upstream update is being checked and validated.", false);
  if (state.status === "needs-resolution" || details.conflicts.length) {
    return result("needs-resolution", "error", "An upstream merge needs a code fix. The working release is retained.");
  }
  if (["failed", "retry-wait"].includes(state.status)) {
    return result(state.status, "error", "An update failed validation. The working release is retained and retries are scheduled.");
  }
  if (state.status === "sync-pending") {
    return result("sync-pending", "warning", "The running release still needs to be synchronized with GitHub.");
  }
  if (state.status === "deferred") {
    const overdue = stamp(state.deferredSince) && now - state.deferredSince > DEFER_WARNING_SECONDS;
    return result("deferred", overdue ? "warning" : "info", overdue
      ? "An update has been waiting more than six hours. Check the deployment blocker."
      : "An update is waiting for a safe deployment window.", Boolean(overdue));
  }
  if (["updated", "up-to-date"].includes(state.status) && (!revision || revision === state.currentRevision)) {
    return result("up-to-date", "ok", "Automatic updates are healthy. The fork includes the latest checked upstream release.", false);
  }
  return result("unknown", "warning", "Update status needs verification. Open Studio controls for details.");
}

async function readUpdateHealth(directory, revision, now = Date.now() / 1000) {
  if (!directory) return { managed: false };
  const state = await fs.readFile(path.join(directory, "status.json"), "utf8")
    .then(text => JSON.parse(text)).catch(() => null);
  const pausedSince = await fs.stat(path.join(directory, "paused")).then(stat => stat.mtimeMs / 1000)
    .catch(error => error.code === "ENOENT" ? null : 0);
  return summarizeUpdateHealth(state, { now, pausedSince, revision });
}

module.exports = { readUpdateHealth, summarizeUpdateHealth };
if (require.main === module) {
  readUpdateHealth(process.argv[2], process.argv[3]).then(value => console.log(JSON.stringify(value))).catch(() => process.exit(1));
}
