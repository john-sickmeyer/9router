import { reopenOpenaiBilling } from "@/lib/studio/openaiBilling.js";
import { getOpenaiCreditBalance, setOpenaiCreditBalance } from "@/lib/localDb";

export async function GET() {
  return Response.json({ credit: await getOpenaiCreditBalance() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (body?.action === "set-credit-balance") {
    try {
      const credit = await setOpenaiCreditBalance(body);
      // A newly supplied positive balance is the operator's recovery signal.
      if (credit.balanceUsd > 0) for (const id of credit.connectionIds) await reopenOpenaiBilling(id);
      return Response.json({ credit });
    } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
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
