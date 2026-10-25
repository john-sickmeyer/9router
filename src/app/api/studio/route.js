import { getProviderConnections } from "@/lib/localDb";
import { refreshControlCapabilities } from "@/lib/studio/capabilities";
import { controlStatus } from "@/lib/studio/audit";
import { CODEX_EFFORTS, CLAUDE_EFFORTS, CLAUDE_FAST_MODELS, CAPABILITY_TTL_MS } from "open-sse/config/studioControls.js";
import { connectionSupportsControls } from "open-sse/services/studioControls.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const connections = await getProviderConnections({ isActive: true });
  const choices = [];
  for (const [provider, prefix, models] of [["codex", "cx", CODEX_EFFORTS], ["claude", "cc", CLAUDE_EFFORTS]]) {
    for (const [model, efforts] of Object.entries(models)) {
      const accounts = connections.filter(c => c.provider === provider);
      if (!accounts.length) continue;
      const speeds = ["standard"];
      if (provider === "claude" && CLAUDE_FAST_MODELS.has(model)) speeds.push("fast");
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
  return Response.json({ results: await refreshControlCapabilities({ force: true }) });
}
