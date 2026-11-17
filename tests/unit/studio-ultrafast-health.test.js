import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createUltrafastMeasurement } from "../../open-sse/services/ultrafastMeasurement.js";
import { newSpeedHealth, speedQualified, speedOwner, applyProbeSpeed, applyLiveSpeed, SPEED_TIMING, ULTRAFAST_PING } from "../../open-sse/services/ultrafastPolicy.js";
import { observeSpeedTraffic, claimIdleSpeedProbe, releaseIdleSpeedProbe, speedTraffic, speedSessionId } from "@/lib/studio/speedTraffic.js";

const fx = vi.hoisted(() => ({ adapter:null, accounts:[], probes:[], calls:[], events:[] }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter:async () => fx.adapter }));
vi.mock("@/lib/localDb", async () => ({ getProviderConnectionById:(await import("@/lib/db/repos/connectionsRepo.js")).getProviderConnectionById,
  getProviderConnections:async () => fx.accounts }));
vi.mock("@/lib/studio/audit.js", () => ({ isControlDraining:() => false, recordControl:async event => fx.events.push(event) }));
vi.mock("@/sse/services/ultrafastProbe.js", () => ({ enrollUltrafastAccounts:async () => {}, runUltrafastProbe:async (row, id, signal) => {
  fx.calls.push(row.connectionId);
  const sample = fx.probes.shift();
  if (typeof sample === "function") return sample(signal);
  return sample || { classification:"insufficient", reason:"fixture" };
} }));
const health = await import("@/lib/studio/ultrafastHealth.js");
const connections = await import("@/lib/db/repos/connectionsRepo.js");
const reserve = await import("@/lib/studio/codexQuotaReserve.js");
await import("@/sse/services/ultrafastProbe.js");
const fast = { classification:"fast", tps:240 };
const slow = { classification:"slow", tps:50 };
const count = Array.from({length:384},(_,i)=>String(200+i)).join(" ");

describe("visible delivery", () => {
  it("uses o200k reference tokens, excludes the first read and startup, and counts transport reads instead of SSE events", async () => {
    const m=createUltrafastMeasurement(count);
    const parts=count.split(" ");
    for(let i=0;i<parts.length;i++) {
      m.observe({ type:"response.output_text.delta", delta:(i?" ":"")+parts[i] }, 90000+Math.floor(i/4)*8);
    }
    const r=await m.finish();
    expect(r).toMatchObject({ classification:"fast", referenceTokens:767, tokensAfterFirst:760, reads:96, durationMs:760, tps:1000 });
    expect(JSON.stringify(r)).not.toContain(count.slice(0,16));
  });
  it("excludes tool, interleaved reasoning, single-read and wrong outputs from qualification", async () => {
    for(const extra of [{ type:"response.function_call_arguments.delta", delta:"{}" },{ type:"response.reasoning_text.delta",delta:"think" }]){
      const m=createUltrafastMeasurement();m.observe({ type:"response.output_text.delta",delta:count },100);m.observe(extra,120);
      expect(await m.finish()).toMatchObject({ classification:"insufficient",reason:"mixed-output" });
    }
    const buffered=createUltrafastMeasurement(count);buffered.observe({ type:"response.output_text.delta",delta:count },1);
    expect(await buffered.finish()).toMatchObject({ classification:"insufficient",reason:"short-or-buffered" });
    const wrong=createUltrafastMeasurement(count);wrong.observe({ type:"response.output_text.delta",delta:"wrong" },1);
    expect(await wrong.finish()).toMatchObject({ classification:"insufficient",reason:"output-mismatch" });
    const stalled=createUltrafastMeasurement();
    stalled.observe({type:"response.output_text.delta",delta:count.slice(0,400)},100);
    stalled.consumerPause(250);
    expect(await stalled.finish()).toMatchObject({classification:"insufficient",reason:"consumer-backpressure"});
  });
  it("keeps live rates as telemetry, without renewing a qualification or counting multiple updates as independent checks", () => {
    let row=newSpeedHealth("one","codex","identity",0);
    const update=(at, sample)=>{row=applyLiveSpeed(row,"gpt-6.2-sol",{...sample,requestId:"stream",sampledAt:at},at);};
    update(1,fast);update(2,fast);expect(row.status).toBe("untested");
    row=applyProbeSpeed(applyProbeSpeed(row,fast,10),fast,20);
    update(1000,fast);expect(row.qualifiedUntil).toBe(20+SPEED_TIMING.freshness);
    update(2000,{...slow,partial:true});update(3000,slow);
    expect(row).toMatchObject({status:"checking",slowStreak:0});
    update(4000,{classification:"insufficient",reason:"mixed-output",tps:null});
    expect(row.lastLive.at).toBe(3000);expect(row.lastObservation.reason).toBe("mixed-output");
  });
});
describe("qualification and recovery", () => {
  it("holds an inconclusive controlled result and binds older Codex records to the account across token refresh",()=>{
    const jwt=(account,exp)=>"h."+Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:account},exp})).toString("base64url")+".s";
    const owner=(account,exp)=>speedOwner({provider:"codex",accessToken:jwt(account,exp)});
    expect(owner("one",1)).toBe(owner("one",2));expect(owner("one",1)).not.toBe(owner("two",1));
    const row=applyProbeSpeed(applyProbeSpeed(newSpeedHealth("one","codex","identity",0),fast,1),fast,2);
    const pending=applyProbeSpeed(row,{classification:"indeterminate",tps:110},3);
    expect(pending).toMatchObject({status:"checking",slowStreak:0,qualifiedUntil:0});
  });
  it("requires independent confirmations and keeps an exhausted or ambiguous probe separate from speed failure", () => {
    let row=newSpeedHealth("account","codex","identity",0);
    row=applyProbeSpeed(row,fast,10); expect(speedQualified(row,11)).toBe(false);
    row=applyProbeSpeed(row,fast,20); expect(speedQualified(row,21)).toBe(true);
    row=applyLiveSpeed(row,"gpt-6.2-astra",slow,30);expect(row.status).toBe("checking");
    row=applyProbeSpeed(row,slow,40);expect(row.status).toBe("checking");
    row=applyProbeSpeed(row,slow,50);expect(row.status).toBe("suspended");
    row=applyProbeSpeed(row,{ classification:"insufficient",reason:"http-429" },60);expect(row.status).toBe("suspended");
    row=applyProbeSpeed(row,fast,70);expect(row.status).toBe("suspended");
    row=applyProbeSpeed(row,fast,80);expect(speedQualified(row,81)).toBe(true);
    expect(speedQualified(row,80+SPEED_TIMING.freshness+1)).toBe(false);
    row=applyProbeSpeed(row,fast,80+SPEED_TIMING.freshness+2);expect(row.status).toBe("checking");
    expect(ULTRAFAST_PING).toEqual({ model:"gpt-6.2-sol",effort:"low",tier:"ultrafast" });
  });
  it("retains qualification when an 80.4 TPS mid-stream reading finishes at 248.6 TPS",()=>{
    let row=applyProbeSpeed(applyProbeSpeed(newSpeedHealth("one","codex","owner",0),fast,10),fast,20);
    const mid=applyLiveSpeed(row,"gpt-6.2-sol",{...slow,tps:80.4,partial:true},30);
    expect(mid).toBe(row);
    row=applyLiveSpeed(mid,"gpt-6.2-sol",{...fast,tps:248.6},40);
    expect(row).toMatchObject({status:"qualified",lastLive:{tps:248.6}});
    expect(speedQualified(row,40)).toBe(true);
    expect(applyLiveSpeed(row,"gpt-6.2-sol",slow,50).status).toBe("checking");
  });
});

describe("persistent account admission", () => {
  let db;
  const singleton=Symbol.for("9router.studio.ultrafast.scheduler");
  async function advance(milliseconds) {
    for (let left=milliseconds; left>0; left-=2000) {
      await vi.advanceTimersByTimeAsync(Math.min(left,2000));
      await globalThis[singleton].current;
    }
  }
  beforeEach(()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-17T20:00:00Z"));
    vi.stubEnv("STUDIO_RELEASE","fixture");vi.stubEnv("STUDIO_CURATED_CATALOG","1");
    db=new DatabaseSync(":memory:");db.exec("CREATE TABLE kv(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key)); CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE providerConnections(id TEXT PRIMARY KEY,provider TEXT,authType TEXT,name TEXT,email TEXT,priority INTEGER,isActive INTEGER,data TEXT,createdAt TEXT,updatedAt TEXT)");
    fx.adapter={ get:(sql,p=[])=>db.prepare(sql).get(...p), all:(sql,p=[])=>db.prepare(sql).all(...p),run:(sql,p=[])=>db.prepare(sql).run(...p),
      transaction:fn=>{db.exec("BEGIN");try{const value=fn();db.exec("COMMIT");return value;}catch(e){db.exec("ROLLBACK");throw e;}} };
    fx.accounts=[{ id:"one",provider:"codex",isActive:true,providerSpecificData:{workspaceId:"ws1"} }];
    db.prepare("INSERT INTO providerConnections(id,provider,isActive,data) VALUES('one','codex',1,?)").run(JSON.stringify({providerSpecificData:fx.accounts[0].providerSpecificData}));
    fx.calls=[];fx.probes=[];fx.events=[];
  });
  afterEach(()=>{clearInterval(globalThis[singleton].timer);globalThis[singleton].timer=null;globalThis[singleton].nextInventory=0;
    globalThis[Symbol.for("9router.studio.speedTraffic")].clear();db.close();vi.unstubAllEnvs();vi.useRealTimers();});
  it("expedites an existing speed test and coalesces duplicate requests", async () => {
    fx.probes.push(fast, fast, fast);
    await health.filterUltrafastAccounts("codex", "gpt-6.2-sol", fx.accounts);
    await advance(14000);
    expect(fx.calls).toHaveLength(2);
    expect(await health.requestCodexSpeedTest("one")).toBeNull();
    expect(await health.requestCodexSpeedTest("one")).toBeNull();
    expect((await health.ultrafastStatus()).rows[0].manualQueued).toBe(true);
    await advance(12000);
    expect(fx.calls).toHaveLength(3);
    expect((await health.ultrafastStatus()).rows[0].manualQueued).toBe(false);
  });
  it("uses one account ping across models, admits only confirmed accounts, and resumes after two fast recovery pings", async ()=>{
    const select=model=>health.filterUltrafastAccounts("codex",model,fx.accounts);
    expect(await select("gpt-6.2-astra")).toEqual([]);
    expect(await select("gpt-6.1-sol")).toEqual([]);
    expect((await health.ultrafastStatus()).rows).toHaveLength(1);
    fx.probes.push(fast,fast);
    await advance(2000);expect(await select("gpt-6.1-sol")).toEqual([]);
    await advance(12000);expect(await select("gpt-6.2-astra")).toEqual(fx.accounts);
    await health.recordLiveDelivery(fx.accounts[0],"gpt-6.2-astra",slow);
    expect(await select("gpt-6.1-sol")).toEqual([]);
    fx.probes.push(slow,slow);await advance(14000);
    const suspended=(await health.ultrafastStatus()).rows[0];
    expect(suspended).toMatchObject({status:"suspended",autoOff:true,connectionActive:false});
    expect(await health.hasSpeedSuspensions("codex")).toBe(true);expect(suspended.liveByModel["gpt-6.2-astra"].tps).toBe(50);
    fx.probes.push(fast,fast);await advance(SPEED_TIMING.recovery+12000);
    expect(await select("gpt-6.2-astra")).toEqual(fx.accounts);
    expect((await connections.getProviderConnectionById("one")).isActive).toBe(true);
    expect(await health.hasSpeedSuspensions("codex")).toBe(false);
    expect(fx.calls).toEqual(Array(6).fill("one"));
    expect(fx.events.filter(e=>e.source==="probe").every(e=>e.model==="gpt-6.2-sol" && e.requestedEffort==="low")).toBe(true);
  });
  it("preserves speed qualification and the provider switch across quota holds and serializes near-limit admissions",async()=>{
    const c=fx.accounts[0];
    const usage=(a,b,credits=false)=>reserve.saveReserve(c,{session:{remaining:a},weekly:{remaining:b},credits},"usage");
    const decision=async()=>(await reserve.readQuotaDecisions([c]))[c.id];
    await usage(2,40);let view=await decision();expect(view.admissionAvailable).toBe(true);
    reserve.claimNearQuota(c,view);expect((await decision()).admissionAvailable).toBe(false);
    vi.setSystemTime(Date.now()+2000);await usage(2,40);expect((await decision()).admissionAvailable).toBe(true);
    await health.filterUltrafastAccounts("codex","gpt-6.2-sol",fx.accounts);
    fx.probes.push(fast,fast);await advance(14000);
    await usage(1,40);view=await decision();expect(view).toMatchObject({held:true,routable:false,pingAllowed:true});
    expect((await health.ultrafastStatus()).rows[0]).toMatchObject({speedEligible:true,eligible:false,connectionActive:true});
    await usage(0,40);expect((await decision()).pingAllowed).toBe(false);
    await usage(0,40,true);expect(await decision()).toMatchObject({held:true,pingAllowed:true,routable:false});
    await usage(100,40,true);expect((await health.ultrafastStatus()).rows[0].eligible).toBe(true);
    expect(fx.events.some(e=>e.state==="codex-quota-reserve-held")).toBe(true);
    expect(fx.events.some(e=>e.state==="codex-quota-reserve-released")).toBe(true);
  });
  it("does not revive a manually disabled account, and a replacement identity requires fresh qualification", async ()=>{
    await health.setUltrafastMode("observe");expect(await health.filterUltrafastAccounts("codex","gpt-6.2-sol",fx.accounts)).toHaveLength(1);
    await health.setUltrafastMode("enforce");await connections.updateProviderConnection("one",{isActive:false});
    await advance(2000);expect(fx.calls).toEqual([]);expect((await health.ultrafastStatus()).rows).toEqual([]);
    expect((await connections.getProviderConnectionById("one")).isActive).toBe(false);
    await connections.updateProviderConnection("one",{isActive:true});
    await health.filterUltrafastAccounts("codex","gpt-6.2-sol",fx.accounts);fx.probes.push(fast,fast);
    await advance(14000);
    fx.accounts[0].providerSpecificData.workspaceId="ws2";
    expect(await health.filterUltrafastAccounts("codex","gpt-6.2-sol",fx.accounts)).toEqual([]);
  });
  it("revokes automatic reactivation when the operator chooses keep off on an automatically disabled connection", async ()=>{
    await health.filterUltrafastAccounts("codex","gpt-6.2-sol",fx.accounts);fx.probes.push(slow,slow);
    await advance(14000);
    expect((await connections.getProviderConnectionById("one")).studioUltrafastAutoOff).toBeTruthy();
    await connections.updateProviderConnection("one",{isActive:false});
    expect((await health.ultrafastStatus()).rows).toHaveLength(0);
    fx.probes.push(fast,fast);await advance(SPEED_TIMING.recovery+20000);
    expect((await connections.getProviderConnectionById("one")).isActive).toBe(false);
    expect(fx.calls).toHaveLength(2);
  });
  it("shows simultaneous live requests and defers the controlled test until their last response drains",async ()=>{
    const event=(requestId,state,more={})=>observeSpeedTraffic({provider:"codex",connectionId:"one",model:"gpt-6.2-astra",
      requestedTier:"ultrafast",requestedEffort:"xhigh",requestId,state,...more});
    await health.filterUltrafastAccounts("codex","gpt-6.2-astra",fx.accounts);
    event("r1","started",{sessionId:"session-one"});event("r2","started",{sessionId:"session-two"});
    event("r1","ultrafast-live-sample",{delivery:fast});
    await advance(24000);expect(fx.calls).toEqual([]);
    const active=(await health.ultrafastStatus()).rows[0].activeRequests;
    expect(active).toHaveLength(2);expect(active[0]).toMatchObject({sessionId:"session-one",delivery:{tps:240}});
    event("r1","completed");await advance(65000);expect(fx.calls).toEqual([]);
    event("r2","cancelled");await advance(SPEED_TIMING.quiet-1);expect(fx.calls).toEqual([]);
    fx.probes.push(fast,fast);await advance(14000);
    expect((await health.ultrafastStatus()).rows[0]).toMatchObject({speedEligible:true,eligible:false});
    await reserve.saveReserve(fx.accounts[0],{session:{remaining:80},weekly:{remaining:90}},"usage");
    expect((await health.ultrafastStatus()).rows[0].eligible).toBe(true);
  });
  it("an arriving user request preempts its own idle test without changing the speed evidence",async ()=>{
    await health.filterUltrafastAccounts("codex","gpt-6.2-sol",fx.accounts);
    let began;
    const started=new Promise(resolve=>{began=resolve;});
    fx.probes.push(signal=>new Promise(resolve=>{began();signal.addEventListener("abort",()=>resolve(slow),{once:true});}));
    await vi.advanceTimersByTimeAsync(2000);await started;expect(fx.calls).toEqual(["one"]);
    const probeOther=claimIdleSpeedProbe("different");
    observeSpeedTraffic({provider:"codex",connectionId:"one",model:"gpt-6.2-sol",requestId:"r1",state:"started"});
    await globalThis[singleton].current;
    expect((await health.ultrafastStatus()).rows[0]).toMatchObject({slowStreak:0,probing:false,status:"untested"});
    expect(fx.events.some(e=>e.state==="ultrafast-probe-deferred")).toBe(true);
    expect(probeOther.signal.aborted).toBe(false);releaseIdleSpeedProbe("different",probeOther);
    expect(speedTraffic("one").requests).toHaveLength(1);
    expect(speedSessionId({"session_id":"private-client-value"},{})).toMatch(/^[a-f\d]{16}$/);
  });
});
