import { reopenOpenaiBilling } from "@/lib/studio/openaiBilling.js";
import { getOpenaiCreditBalance, setOpenaiCreditBalance, getProviderConnections } from "@/lib/localDb";
import { setOpenaiAdminKey, removeOpenaiAdminKey, setOpenaiGrants, refreshOpenaiAdminBalances, getOpenaiAdminBalances } from "@/lib/studio/openaiAdminBalance.js";

const fail = error => Response.json({ error: error.message }, { status: error.status || 400 });

// Admin-key and grant actions only read OpenAI billing data; none of them change routing or billing state.
async function adminAction(body) {
  if (typeof body.connectionId !== "string" && body.action !== "refresh-balances") return Response.json({ error: "Expected an OpenAI connection ID" }, { status: 400 });
  if (body.action === "set-admin-key") await setOpenaiAdminKey(body.connectionId, body.adminKey);
  else if (body.action === "remove-admin-key") await removeOpenaiAdminKey(body.connectionId);
  else if (body.action === "set-grants") await setOpenaiGrants(body.connectionId, body.grants);
  else await refreshOpenaiAdminBalances(await getProviderConnections({ provider: "openai" }), { force: body.force === true });
  return Response.json({ balances: await getOpenaiAdminBalances(await getProviderConnections({ provider: "openai" })) });
}

export async function GET() {
  return Response.json({ credit: await getOpenaiCreditBalance() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (["set-admin-key", "remove-admin-key", "set-grants", "refresh-balances"].includes(body?.action)) {
    try { return await adminAction(body); } catch (error) { return fail(error); }
  }
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
