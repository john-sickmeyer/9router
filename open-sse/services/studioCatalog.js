import { STUDIO_VISIBLE_MODELS } from "../config/studioControls.js";
import { effortLevels } from "./studioControls.js";

// Discovery is deliberately smaller than routing: existing conversations and
// explicit Codex speed aliases keep working without multiplying picker rows.
export function studioModelCatalog(models, { anthropic = false } = {}) {
  const available = new Map(models.map(model => [model.id, model]));
  return STUDIO_VISIBLE_MODELS.flatMap(({ id, name, provider }) => {
    if (anthropic && provider !== "claude") return [];
    const source = available.get(id);
    if (!source) return [];
    const entry = { ...source, name, display_name: name };
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
