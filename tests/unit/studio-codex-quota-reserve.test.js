import { describe, it, expect } from "vitest";
import { CODEX_RESERVE } from "../../open-sse/config/ultrafastHealth.js";
import { mergeReserve, reserveDecision, reserveFromHeaders, reserveFromUsage, reserveRefreshDue } from "../../open-sse/services/codexQuotaReserve.js";

const at = Date.parse("2026-11-17T18:00:00Z");
const window = used => ({ used_percent:used, reset_at:(at+120_000)/1000 });
const evidence = (short, weekly, credits) => reserveFromUsage({ primary_window:window(short), secondary_window:window(weekly) },credits);

describe("Codex quota reserve", () => {
  it("uses the declared weekly-only plan and ignores unused secondary headers",()=>{
    const only=used=>reserveFromUsage({primary_window:{...window(used),limit_window_seconds:604800},secondary_window:null},{});
    let row=mergeReserve(null,only(20),"usage",at);
    expect(reserveDecision(row,at)).toMatchObject({session:null,weekly:{remaining:80},routable:true});
    const headers=new Headers({"x-codex-primary-used-percent":"99","x-codex-primary-window-minutes":"10080",
      "x-codex-secondary-used-percent":"0","x-codex-secondary-window-minutes":"0"});
    row=mergeReserve(row,reserveFromHeaders(headers),"headers",at+1);
    expect(reserveDecision(row,at+1)).toMatchObject({session:null,weekly:{remaining:1},held:true});
    const incomplete=reserveFromUsage({primary_window:{...window(0),limit_window_seconds:604800}},{});
    row=mergeReserve(row,incomplete,"usage",at+2);
    expect(reserveDecision(row,at+2).held).toBe(true);
    row=mergeReserve(row,only(0),"usage",at+2);
    expect(reserveDecision(row,at+2)).toMatchObject({weekly:{remaining:100},routable:true});
  });
  it.each([[98.9,50,false],[99,50,true],[50,99,true],[50,100,true]])("uses either raw window and an inclusive cutoff (%s, %s)",(a,b,held)=>{
    const row=mergeReserve(null,evidence(a,b),"usage",at);
    expect(reserveDecision(row,at)).toMatchObject({held,routable:!held,threshold:1});
  });
  it("holds immediately on a partial header and requires fresh complete usage to lift the hold",()=>{
    let row=mergeReserve(null,evidence(60,75),"usage",at);
    const header=reserveFromHeaders(new Headers({"x-codex-secondary-used-percent":"99"}));
    row=mergeReserve(row,header,"headers",at+1);
    expect(reserveDecision(row,at+1)).toMatchObject({held:true,remaining:1});
    row=mergeReserve(row,evidence(20,20),"usage",at-1);
    row=mergeReserve(row,evidence(20,20),"headers",at+2);
    row=mergeReserve(row,evidence(undefined,20),"usage",at+3);
    expect(reserveDecision(row,at+3).routable).toBe(false);
    row=mergeReserve(row,evidence(20,20),"usage",at+5);
    expect(reserveDecision(row,at+5).routable).toBe(true);
  });
  it("blocks missing or stale readings and rechecks a held account at its reset",()=>{
    const partial=mergeReserve(null,evidence("garbage",2),"usage",at);
    expect(reserveDecision(partial,at).routable).toBe(false);
    const near=mergeReserve(null,evidence(98,10),"usage",at);
    expect(reserveDecision(near,at+CODEX_RESERVE.nearFreshMs).routable).toBe(false);
    const held=mergeReserve(null,evidence(99,10),"usage",at);
    expect(reserveRefreshDue(held,at+119999)).toBe(false);
    expect(reserveRefreshDue(held,at+120000)).toBe(true);
    expect(reserveDecision(held,at+120001).held).toBe(true);
  });
  it("recognizes actual funded credits separately from subscription percentage and from reset credits",()=>{
    for (const credit of [{ has_credits:true,balance:"0" },{ unlimited:true,overage_limit_reached:true },{ available_count:20 }]) {
      expect(evidence(100,20,credit).credits).toBe(false);
    }
    expect(evidence(100,20,{ has_credits:true,balance:"1.5" }).credits).toBe(true);
    expect(evidence(100,20,{ unlimited:true }).credits).toBe(true);
  });
});
