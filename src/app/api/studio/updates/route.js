import { readUpdateHealth } from "../../../../../scripts/studio-update-health.cjs";
import { getProviderConnections } from "@/lib/localDb";
import { openaiPoolWarnings } from "@/lib/studio/openaiHealth.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await readUpdateHealth(process.env.STUDIO_UPDATE_STATE_DIR, process.env.STUDIO_RELEASE);
  const providerWarnings = openaiPoolWarnings(await getProviderConnections({ provider: "openai", isActive: true }));
  return Response.json({ ...health, providerWarnings }, { headers: { "Cache-Control": "no-store" } });
}
