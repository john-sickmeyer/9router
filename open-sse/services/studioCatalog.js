import { STUDIO_VISIBLE_MODELS, STUDIO_CODEX_PICKER_SPEEDS, SPEEDS, SPEED_NAMES } from "../config/studioControls.js";
import { effortLevels } from "./studioControls.js";

// Keep two model families, with explicit speed-only Codex choices. Effort stays
// independent, so the picker never grows into every speed/effort permutation.
export function studioModelCatalog(models, { anthropic = false } = {}) {
  const available = new Map(models.map(model => [model.id, model]));
  return STUDIO_VISIBLE_MODELS.flatMap(({ id, name, provider }) => {
    if (anthropic && provider !== "claude") return [];
    const source = available.get(id);
    if (!source) return [];
    const entry = { ...source, name, display_name: name };
    if (provider === "codex") {
      return STUDIO_CODEX_PICKER_SPEEDS.map(speed => {
        const label = speed === "standard" ? name : `${name} ${SPEED_NAMES[SPEEDS[speed]]}`;
        return { ...entry, id: `${id}@${speed}`, name: label, display_name: label,
          studio_controls: { speed, effort: null, base_model: id } };
      });
    }
    // Claude's runtime reports canonical IDs. Matching them avoids a second
    // selected-model row beside the gateway-prefixed spelling in Happier.
    if (anthropic) entry.id = id.slice(id.indexOf("/") + 1);
    if (provider === "claude") {
      const levels = effortLevels(provider, id.slice(id.indexOf("/") + 1));
      entry.type = "model";
      entry.capabilities = {
        ...source.capabilities,
        effort: { supported: true, ...Object.fromEntries(levels.map(level => [level, { supported: true }])) },
      };
      if (source.context_length) entry.max_input_tokens = source.context_length;
      if (source.max_completion_tokens) entry.max_tokens = source.max_completion_tokens;
    }
    return [entry];
  });
}
