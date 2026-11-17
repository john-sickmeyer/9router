import { describe, expect, it } from "vitest";
import { createCodexTurnRoute } from "../../open-sse/services/codexTurnState.js";
import { CODEX_TURN_STATE_HEADER } from "../../open-sse/config/studioControls.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

describe("Codex continuation ownership", () => {
  it("keeps the replacement owner when an overlapping response from the original owner arrives late", () => {
    const session = crypto.randomUUID();
    const turn = state => createCodexTurnRoute(new Headers({
      session_id: session, ...(state ? { [CODEX_TURN_STATE_HEADER]: state } : {}),
    }), {}, "fixture");
    const first = turn();
    first.observe("one","workspace-one","A");
    first.forwardTo(new Headers(),"one");
    const delayed = turn("A"), replacement = turn("A");
    replacement.observe("two","workspace-two","B");
    replacement.forwardTo(new Headers(),"two");
    delayed.observe("one","workspace-one","A");
    delayed.forwardTo(new Headers(),"one");
    expect(turn("A").preferredConnectionId).toBe("two");
    expect(turn("A").forRequest("two","workspace-two")).toBe("B");
    expect(turn("A").forRequest("one","workspace-one")).toBeNull();
  });

  it("never injects a fixed per-provider header into a fresh turn", () => {
    const headers = { "X-Codex-Turn-State": "static-override", "ChatGPT-Account-ID": "fixture" };
    new CodexExecutor().finalizeHeaders(headers, { model: "gpt-6.2-sol", service_tier: "ultrafast" }, {});
    expect(new Headers(headers).has(CODEX_TURN_STATE_HEADER)).toBe(false);
    expect(headers["x-codex-routing-hint"]).toBe("model=gpt-6.2-sol;tier=ultrafast");
  });

  it("replays state for a bearer-only connection only while its outgoing authorization still matches", () => {
    const session = crypto.randomUUID();
    const route = marker => createCodexTurnRoute(new Headers({
      session_id: session, ...(marker ? { [CODEX_TURN_STATE_HEADER]: marker } : {}),
    }), {}, "fixture");
    const executor = new CodexExecutor();
    const credentials = { connectionId: "legacy", codexTurnRoute: route() };
    const original = { Authorization: "Bearer old-fixture" };
    const reply = new Headers({ [CODEX_TURN_STATE_HEADER]: "legacy-marker" });
    executor.observeResponseHeaders(original, reply, credentials);
    credentials.codexTurnRoute.forwardTo(new Headers(), "legacy");
    credentials.codexTurnRoute = route("legacy-marker");
    expect(executor.finalizeHeaders({ ...original }, {}, credentials)[CODEX_TURN_STATE_HEADER]).toBe("legacy-marker");
    expect(executor.finalizeHeaders({ Authorization: "Bearer new-fixture" }, {}, credentials)[CODEX_TURN_STATE_HEADER]).toBeUndefined();
    expect(executor.finalizeHeaders({}, {}, credentials)[CODEX_TURN_STATE_HEADER]).toBeUndefined();

    credentials.codexTurnRoute = route();
    executor.observeResponseHeaders({}, reply, credentials);
    const downstream = new Headers();
    credentials.codexTurnRoute.forwardTo(downstream, "legacy");
    expect(downstream.has(CODEX_TURN_STATE_HEADER)).toBe(false);
  });
});
