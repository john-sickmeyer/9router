import { readUpdateHealth } from "../../../../../scripts/studio-update-health.cjs";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await readUpdateHealth(process.env.STUDIO_UPDATE_STATE_DIR, process.env.STUDIO_RELEASE);
  return Response.json(health, { headers: { "Cache-Control": "no-store" } });
}
