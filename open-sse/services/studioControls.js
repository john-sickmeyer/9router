import { CONTROL_PROVIDERS, SPEEDS, CODEX_EFFORTS, CLAUDE_EFFORTS, CLAUDE_FAST_MODELS, SPEED_NAMES, CAPABILITY_TTL_MS } from "../config/studioControls.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";

export class ControlError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// A model alias works even in clients with no independent speed selector.
export function splitControlModel(value) {
  let model = String(value || "");
  let effort = null;
  const suffix = model.match(/\(([^()]+)\)\s*$/);
  if (suffix) { effort = suffix[1].trim().toLowerCase(); model = model.slice(0, suffix.index); }
  const speed = model.match(/@([a-z]+)$/i);
  if (speed) model = model.slice(0, speed.index);
  return { model, effort, speed: speed?.[1]?.toLowerCase() || null };
}

function choose(values, label) {
  const specified = values.filter(v => v !== undefined && v !== null);
  if (specified.some(v => typeof v !== "string" || !v.trim())) throw new ControlError(`Invalid ${label}`);
  const unique = [...new Set(specified.map(v => v.toLowerCase()))];
  if (unique.length > 1) throw new ControlError(`Conflicting ${label}: ${unique.join(", ")}. Use one value in the model alias and request body.`);
  return unique[0] || null;
}

export function effortLevels(provider, model) {
  return (provider === "codex" ? CODEX_EFFORTS[model] : CLAUDE_EFFORTS[model]) || getThinkingLevels(provider, model) || [];
}

export function resolveControls(provider, model, body, requested = {}, providerThinking = null) {
  if (!CONTROL_PROVIDERS.has(provider)) return null;
  const parsed = splitControlModel(model);
  const base = parsed.model;
  const isCodex = provider === "codex";
  const speedInputs = [requested.speed, parsed.speed, isCodex ? body.service_tier : body.speed].filter(v => v != null);
  const tier = choose(speedInputs.map(v => {
    if (typeof v !== "string" || !Object.hasOwn(SPEEDS, v.toLowerCase())) throw new ControlError(`Unsupported speed: ${String(v)}`);
    return SPEEDS[v.toLowerCase()];
  }), "speed");
  if (!isCodex && tier && tier !== "default" && (tier !== "priority" || !CLAUDE_FAST_MODELS.has(base))) {
    throw new ControlError(`Fast mode is not supported for ${base}`);
  }
  let effort = choose([requested.effort, parsed.effort, body.reasoning?.effort, body.reasoning_effort, body.output_config?.effort], "effort");
  // Legacy auto/budget suffixes still use the upstream thinking implementation.
  if (effort === "auto" || /^\d+$/.test(effort || "")) {
    if (tier) throw new ControlError("Use an explicit effort level with a speed alias");
    return null;
  }
  if (!effort && providerThinking?.mode && !["auto", "on", "off"].includes(providerThinking.mode)) effort = providerThinking.mode;
  const levels = effortLevels(provider, base);
  if (effort && !levels.includes(effort)) throw new ControlError(`Unsupported effort '${effort}' for ${base}. Supported: ${levels.join(", ") || "none"}`);
  return { provider, model: base, tier, effort };
}

export function applyControls(body, controls) {
  if (!controls) return body;
  if (controls.provider === "codex") {
    if (controls.effort) body.reasoning = { ...body.reasoning, effort: controls.effort };
    delete body.reasoning_effort;
    if (controls.tier === "default") delete body.service_tier;
    else if (controls.tier) body.service_tier = controls.tier;
  } else {
    if (controls.effort) body.output_config = { ...body.output_config, effort: controls.effort };
    delete body.reasoning_effort;
    if (controls.tier) body.speed = controls.tier === "priority" ? "fast" : "standard";
  }
  return body;
}

export function assertOutboundControls(body, controls) {
  if (!controls) return;
  const isCodex = controls.provider === "codex";
  const tier = isCodex ? body.service_tier || "default" : SPEEDS[body.speed || "standard"];
  const effort = isCodex ? body.reasoning?.effort : body.output_config?.effort;
  if (controls.tier && tier !== controls.tier) throw new ControlError("Outbound speed differs from the requested speed");
  if (controls.effort && effort !== controls.effort) throw new ControlError("Outbound effort differs from the requested effort");
}

export function controlLockKey(model, controls) {
  return controls?.tier && controls.tier !== "default" ? `${model}@${controls.tier}` : model;
}

export function connectionSupportsControls(connection, controls, now = Date.now()) {
  if (!controls || controls.provider !== "codex") return true;
  const catalog = connection.providerSpecificData?.studioCapabilities;
  const caps = catalog?.models?.[controls.model];
  if (controls.tier && controls.tier !== "default") {
    // Fail closed on missing/stale evidence; the selector refreshes first.
    if (!caps || now - Date.parse(catalog.checkedAt) > CAPABILITY_TTL_MS || !Number.isFinite(Date.parse(catalog.checkedAt))) return false;
    if (!caps.tiers?.includes(controls.tier)) return false;
  }
  return !controls.effort || !caps || caps.efforts?.includes(controls.effort);
}

export function expandControlModels(models, connections) {
  const result = [...models];
  const seen = new Set(models.map(m => m.id));
  for (const entry of models) {
    const [prefix, ...rest] = entry.id.split("/");
    const provider = { cx: "codex", codex: "codex", cc: "claude", claude: "claude" }[prefix];
    if (!provider) continue;
    const model = rest.join("/");
    if (model.includes("(") || model.includes("@") || model.includes("[")) continue;
    const levels = effortLevels(provider, model);
    if (!levels.length) continue;
    for (const [speed, tier] of Object.entries({ standard: "default", fast: "priority", ultrafast: "ultrafast" })) {
      if (provider === "claude" && tier !== "default" && (tier !== "priority" || !CLAUDE_FAST_MODELS.has(model))) continue;
      if (provider === "codex" && tier !== "default" && !connections.some(c => c.provider === provider && connectionSupportsControls(c, { provider, model, tier }))) continue;
      for (const effort of [null, ...levels]) {
        const id = `${entry.id}@${speed}${effort ? `(${effort})` : ""}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({ ...entry, id, name: `${entry.name || model} · ${SPEED_NAMES[tier]}${effort ? ` · ${effort}` : ""}`, studio_controls: { speed, effort, base_model: entry.id } });
      }
    }
  }
  return result;
}
