export const ULTRAFAST_PING = Object.freeze({ model: "gpt-6.2-sol", effort: "low", tier: "ultrafast" });
export const CODEX_RESERVE = Object.freeze({
  percent: 1,
  nearPercent: 3,
  freshMs: 120_000,
  nearFreshMs: 10_000,
  heldRecheckMs: 5 * 60_000,
  errorRetryMs: 30_000,
});
export const ULTRAFAST_BANDS = Object.freeze({ slowMax: 85, fastMin: 150, minTokens: 256, minAfterFirst: 192 });
export const SPEED_TIMING = Object.freeze({
  freshness: 30 * 60_000,
  refreshLead: 2 * 60_000,
  quiet: 60_000,
  confirm: 10_000,
  recovery: 5 * 60_000,
  maxRecovery: 30 * 60_000,
  retry: 60_000,
});
