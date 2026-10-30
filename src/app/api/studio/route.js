import { getProviderConnections } from "@/lib/localDb";
import { refreshControlCapabilities, refreshOpenaiControlCapabilities } from "@/lib/studio/capabilities";
import { isOpenaiPoolEnabled, OPENAI_POOL_MODELS, OPENAI_CURRENT_EFFORTS, OPENAI_METADATA_REVIEWED_AT, OPENAI_METADATA_TTL_MS } from "open-sse/config/openaiPlatform.js";
import { controlStatus } from "@/lib/studio/audit";
import { CODEX_EFFORTS, CLAUDE_EFFORTS, CLAUDE_FAST_MODELS, CLAUDE_FAST_ENABLED, STUDIO_VISIBLE_MODELS, isStudioCuratedCatalogEnabled, CAPABILITY_TTL_MS } from "open-sse/config/studioControls.js";
import { connectionSupportsControls } from "open-sse/services/studioControls.js";
import { STUDIO_KIMI_MODELS } from "open-sse/config/moonshot.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const allConnections = await getProviderConnections();
  const connections = allConnections.filter(c => c.isActive !== false);
  const choices = [];
  for (const [provider, prefix, models] of [["codex", "cx", CODEX_EFFORTS], ["claude", "cc", CLAUDE_EFFORTS]]) {
    for (const [model, efforts] of Object.entries(models)) {
      if (isStudioCuratedCatalogEnabled() && !STUDIO_VISIBLE_MODELS.some(entry => entry.id === `${prefix}/${model}`)) continue;
      const accounts = connections.filter(c => c.provider === provider);
      if (!accounts.length) continue;
      const speeds = ["standard"];
      if (provider === "claude" && CLAUDE_FAST_ENABLED && CLAUDE_FAST_MODELS.has(model)) speeds.push("fast");
      if (provider === "codex") {
        for (const [name, tier] of [["fast", "priority"], ["ultrafast", "ultrafast"]]) {
          if (accounts.some(c => connectionSupportsControls(c, { provider, model, tier }))) speeds.push(name);
        }
      }
      choices.push({ id: `${prefix}/${model}`, speeds, efforts });
    }
  }
  return Response.json({
    release: process.env.STUDIO_RELEASE || "development",
    choices,
    connectionIdentities: allConnections.map(c => ({ id: c.id, provider: c.provider })),
    kimiModels: connections.some(c => c.provider === "moonshot") ? STUDIO_KIMI_MODELS.map(m => m.id) : [],
    poolChoices: isOpenaiPoolEnabled() ? OPENAI_POOL_MODELS.map(id => ({ id,
      speeds: ["standard", "fast", "ultrafast"], efforts: OPENAI_CURRENT_EFFORTS })) : [],
    openaiPool: {
      enabled: isOpenaiPoolEnabled(), priority: ["openai", "codex"],
      metadataReviewedAt: OPENAI_METADATA_REVIEWED_AT,
      metadataStale: Date.now() - Date.parse(OPENAI_METADATA_REVIEWED_AT) > OPENAI_METADATA_TTL_MS,
      accounts: connections.filter(c => c.provider === "openai").map(c => ({
        id: c.id, name: c.name, provider: c.provider,
        billing: c.studioBillingState || null,
        checkedAt: c.providerSpecificData?.studioCapabilities?.checkedAt || null,
        catalogStale: !Number.isFinite(Date.parse(c.providerSpecificData?.studioCapabilities?.checkedAt))
          || Date.now() - Date.parse(c.providerSpecificData?.studioCapabilities?.checkedAt) > CAPABILITY_TTL_MS,
      })),
    },
    accounts: connections.filter(c => ["codex", "claude"].includes(c.provider)).map(c => {
      const caps = c.providerSpecificData?.studioCapabilities;
      return { id: c.id, name: c.name || c.email, provider: c.provider, plan: caps?.plan || null,
        checkedAt: caps?.checkedAt || null, stale: !caps || Date.now() - Date.parse(caps.checkedAt) > CAPABILITY_TTL_MS,
        ultrafast: Object.values(caps?.models || {}).some(m => m.tiers.includes("ultrafast")) };
    }),
    ...await controlStatus(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const results = await Promise.all([refreshControlCapabilities({ force: true }), refreshOpenaiControlCapabilities({ force: true })]);
  return Response.json({ results: results.flat() });
}
