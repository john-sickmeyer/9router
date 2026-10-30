import { reopenOpenaiBilling } from "@/lib/studio/openaiBilling.js";

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (body?.action !== "retry-billing" || typeof body.connectionId !== "string") {
    return Response.json({ error: "Expected retry-billing and an OpenAI connection ID" }, { status: 400 });
  }
  try {
    await reopenOpenaiBilling(body.connectionId);
    return Response.json({ message: "The next eligible request will retry this API account. No billing settings were changed." });
  } catch {
    return Response.json({ error: "OpenAI connection not found" }, { status: 404 });
  }
}
