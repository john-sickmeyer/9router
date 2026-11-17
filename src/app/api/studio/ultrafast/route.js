import { setUltrafastMode, speedMonitorEnabled, ultrafastStatus } from "@/lib/studio/ultrafastHealth.js";
import { enrollUltrafastAccounts } from "@/sse/services/ultrafastProbe.js";
import { ULTRAFAST_PING } from "open-sse/config/ultrafastHealth.js";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await ultrafastStatus(), { headers:{ "Cache-Control":"no-store" } });
}
export async function POST(request) {
  if (!speedMonitorEnabled()) return Response.json({ error:"Studio Ultrafast monitoring is unavailable" }, { status:409 });
  const data = await request.json().catch(() => null);
  if (data?.action === "mode" && ["observe","enforce"].includes(data.mode)) {
    await setUltrafastMode(data.mode);
  } else if (data?.action === "check" && ["codex","openai"].includes(data.provider)
      && (!data.model || data.model === ULTRAFAST_PING.model)) {
    await enrollUltrafastAccounts(data.provider);
  } else return Response.json({ error:"Unknown Ultrafast action" }, { status:400 });
  return GET();
}
