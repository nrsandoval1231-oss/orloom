import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionGovernor } from "../packages/governor/src/governor.js";
import { createJevSchedulingAdapter } from "../packages/judgment/src/jev-adapter.js";
import { JevClient } from "../packages/judgment/src/jev-client.js";
import type { SliceInput } from "../packages/contracts/src/mission.js";

const policy="c".repeat(64),recovery="d".repeat(64),baseSha="a".repeat(40),evidence="b".repeat(64);
const future=()=>new Date(Date.now()+60_000).toISOString();
const slice=(id:string,scope:string,deps:string[]=[],budget=100):SliceInput=>({id,objective:id,dependencies:deps,owner:"core",scopes:[scope],checks:["check:unit"],budgetCents:budget});
const config={maxLanes:6,capacitySlots:6,leaseSeconds:300,trustedCheckPolicyDigest:policy,recoveryPolicyDigest:recovery,trustedCheckPolicy:["check:unit"],executionConfigured:true};
const result=(selectedCandidateId:string)=>({selectedCandidateId,modelId:"fixture-model-v1",tokenUsage:{inputTokens:11,outputTokens:7}});

async function memoryPlan(slices:SliceInput[],capacity=6,budget=10_000){
  const store=new MemoryMissionStore();await store.configureCapacity(capacity,evidence,future());
  const mission=await store.submit({repository:"owner/scheduler",baseSha,objective:"scheduling acceptance",acceptance:["one valid lease"],budgetCents:budget});
  await store.recommendPlan(mission.id,slices,"owner-session");await store.approvePlan(mission.id);return{store,mission};
}

test("memory scheduling ranks critical path and applies validated advice only at fresh claim",async()=>{
  const {store,mission}=await memoryPlan([slice("a-root","src/a.ts"),slice("a-child","src/a-child.ts",["a-root"]),slice("a-leaf","src/a-leaf.ts",["a-child"]),slice("z-independent","docs/z.md")],2);
  const snapshot=await store.schedulingSnapshot!(policy,recovery, ["check:unit"]);
  assert.equal(snapshot.choices[0]?.sliceId,"a-root","longest remaining dependency path leads the deterministic rank");
  let calls=0;const governor=new MissionGovernor(store,config,undefined,async choices=>{calls++;return result(`${mission.id}:z-independent`);});
  const grant=await governor.claim();assert(grant);assert.equal(grant.slice.id,"z-independent");assert.equal(calls,1);
  const events=await store.events(mission.id,0),event=events.find(x=>x.type==="slice.claimed")!;const advice=event.data.schedulingAdvice as any;
  assert.equal(advice.dispatchMayHaveOccurred,true);assert.equal(advice.preferredCandidateId,`${mission.id}:z-independent`);assert.equal(advice.snapshotDigest,snapshot.snapshotDigest);assert.equal(advice.modelId,"fixture-model-v1");assert.deepEqual(advice.tokenUsage,{inputTokens:11,outputTokens:7});assert.equal(advice.tokenUsageStatus,"measured");assert.equal("cost" in advice,false);assert.equal("raw" in advice,false);
  const decisions=events.filter(x=>x.type==="scheduling.decision");assert.equal(decisions.length,2);assert.equal(decisions[0]!.data.phase,"dispatch_possible");assert.equal(decisions[1]!.data.phase,"advice_resolved");assert.equal(decisions[1]!.data.validatedCandidateId,`${mission.id}:z-independent`);assert.equal(decisions[1]!.data.trustedCheckPolicyDigest,policy);assert.equal(decisions[1]!.data.recoveryPolicyDigest,recovery);assert.equal(decisions[0]!.data.decisionId,decisions[1]!.data.decisionId);
  assert.equal((await store.getMission(mission.id))?.mission.reservedCents,100);
});

test("scheduler and optional learning activation retain separate dependency slots",async()=>{
  const {store,mission}=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],1);
  let adviceCalls=0,activationCalls=0;
  const governor=new MissionGovernor(store,config,undefined,async choices=>{adviceCalls++;return result(`${mission.id}:${choices.choices[1]!.sliceId}`);},{assertAccepted:async()=>{activationCalls++;}});
  const grant=await governor.claim();assert(grant);assert.equal(grant.slice.id,"b");assert.equal(adviceCalls,1);
  await assert.rejects(governor.promoteLesson("missing-lesson","e".repeat(64)));
  assert.equal(activationCalls,1,"learning activation remains the fifth dependency and is checked before lesson lookup");
});

test("advice is skipped for zero or one eligible choice and Jev context is capped at 32",async()=>{
  const zero=await memoryPlan([slice("parent","src/parent.ts"),slice("child","src/child.ts",["parent"])],1);assert(await zero.store.claim(300,policy, ["check:unit"]));
  const empty=await zero.store.schedulingSnapshot!(policy,recovery, ["check:unit"]);assert.equal(empty.choices.length,0);
  let zeroCalls=0;const emptyGovernor=new MissionGovernor(zero.store,config,undefined,async()=>{zeroCalls++;return result("unused");});assert.equal(await emptyGovernor.claim(),null);assert.equal(zeroCalls,0);
  const one=await memoryPlan([slice("only","src/only.ts")],1);let calls=0;
  const governor=new MissionGovernor(one.store,config,undefined,async()=>{calls++;return result(`${one.mission.id}:only`);});
  assert.equal((await governor.claim())?.slice.id,"only");assert.equal(calls,0);
  const many=await memoryPlan(Array.from({length:36},(_,i)=>slice(`slice-${String(i).padStart(2,"0")}`,`src/${i}.ts`)),6,10_000);
  const snapshot=await many.store.schedulingSnapshot!(policy,recovery, ["check:unit"]);assert.equal(snapshot.choices.length,32);
  assert.deepEqual(snapshot.choices.map(x=>x.sliceId),[...snapshot.choices.map(x=>x.sliceId)].sort());
});

test("memory concurrent claims fence stale advice and preserve deterministic fallback after UNKNOWN",async()=>{
  const {store,mission}=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],2);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
  const governor=new MissionGovernor(store,config,undefined,async snapshot=>{calls++;await gate;return result(`${mission.id}:${snapshot.choices.at(-1)!.sliceId}`);});
  const one=governor.claim(),two=governor.claim();await new Promise(resolve=>setTimeout(resolve,0));release();
  const grants=await Promise.all([one,two]);assert.equal(new Set(grants.filter(Boolean).map(x=>x!.slice.id)).size,2);assert.equal(calls,2);
  const claimEvents=(await store.events(mission.id,0)).filter(x=>x.type==="slice.claimed");assert.equal(claimEvents.length,2);assert(claimEvents.some(x=>(x.data.schedulingAdvice as any)?.status==="stale_fallback"));

  const fallback=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],1);
  let failedCalls=0;const failedGovernor=new MissionGovernor(fallback.store,config,undefined,async()=>{failedCalls++;throw new Error("post-dispatch UNKNOWN");});
  const safe=await failedGovernor.claim();assert(safe);assert.equal(safe.slice.id,"a");assert.equal(failedCalls,1);
  const recorded=(await fallback.store.events(fallback.mission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal((recorded.data.schedulingAdvice as any).status,"unknown");assert.equal((recorded.data.schedulingAdvice as any).dispatchMayHaveOccurred,true);
});

test("invalid advice and bounded Jev timeout keep fallback safe and usage UNKNOWN",async()=>{
  const invalid=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],1);let calls=0;
  const invalidGovernor=new MissionGovernor(invalid.store,config,undefined,async()=>{calls++;return{selectedCandidateId:"not-in-snapshot",modelId:"untrusted model",tokenUsage:{inputTokens:-1,outputTokens:5}};});
  const invalidGrant=await invalidGovernor.claim();assert(invalidGrant);assert.equal(invalidGrant.slice.id,"a");assert.equal(calls,1);
  const invalidEvents=await invalid.store.events(invalid.mission.id,0),resolved=invalidEvents.find(x=>x.type==="scheduling.decision"&&x.data.phase==="advice_resolved")!;assert.equal(resolved.data.status,"invalid");assert.equal(resolved.data.dispatchMayHaveOccurred,true);assert.equal(resolved.data.modelId,null);assert.equal(resolved.data.tokenUsageStatus,"unknown");assert.equal(resolved.data.tokenUsage,null);assert.equal(invalidEvents.some(x=>x.type==="slice.unknown"),false);

  const timed=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],1);let transports=0;
  const client=new JevClient({apiKey:"fixture-key",modelId:"fixture-model",allowedModelIds:new Set(["fixture-model"]),limits:{maxInputBytes:100_000,maxResponseBytes:100_000,timeoutMs:15},fetch:(async()=>{transports++;return await new Promise<Response>(()=>{});}) as never});
  const timedGovernor=new MissionGovernor(timed.store,config,undefined,createJevSchedulingAdapter(client));const timedGrant=await timedGovernor.claim();assert(timedGrant);assert.equal(timedGrant.slice.id,"a");assert.equal(transports,1);
  const timedEvents=await timed.store.events(timed.mission.id,0),unknown=timedEvents.find(x=>x.type==="scheduling.decision"&&x.data.phase==="advice_resolved")!;assert.equal(unknown.data.status,"unknown");assert.equal(unknown.data.dispatchMayHaveOccurred,true);assert.equal(unknown.data.tokenUsageStatus,"unknown");assert.equal(unknown.data.tokenUsage,null);assert.equal(timedEvents.some(x=>x.type==="slice.unknown"),false);
});

test("finite Jev adapter rejects oversized context before transport and emits no arbitrary action",async()=>{
  let transports=0;const fake={choose:async()=>{transports++;return{choice:"slice_1",model:"fixture",usage:{inputTokens:1,outputTokens:1},confidence:1};}};
  const adapter=createJevSchedulingAdapter(fake as never);
  const snapshot={capturedAt:new Date().toISOString(),freeCapacity:2,snapshotDigest:"f".repeat(64),choices:Array.from({length:32},(_,i)=>({missionId:"m".repeat(900),sliceId:`s${i}`,repository:"owner/repo",planDigest:"e".repeat(64),dependencies:[],scopes:[],budgetCents:1,missionBudgetCents:100,reservedBudgetCents:0,downstreamDepth:0,scopeRisk:0,lessons:[]}))};
  await assert.rejects(adapter(snapshot,"33333333-3333-4333-8333-333333333333"));assert.equal(transports,0);
});

test("finite Jev adapter preserves validated model and measured usage with the selected candidate",async()=>{
  const fake={choose:async()=>({choice:"slice_2",model:"fixture-model-v1",usage:{inputTokens:13,outputTokens:5},confidence:1})};const adapter=createJevSchedulingAdapter(fake as never);
  const snapshot={capturedAt:new Date().toISOString(),freeCapacity:1,snapshotDigest:"f".repeat(64),choices:["a","b"].map(sliceId=>({missionId:"mission-id",sliceId,repository:"owner/repo",planDigest:"e".repeat(64),dependencies:[],scopes:[],budgetCents:1,missionBudgetCents:10,reservedBudgetCents:0,downstreamDepth:0,scopeRisk:0,lessons:[]}))};
  const choice=await adapter(snapshot,"33333333-3333-4333-8333-333333333333");assert.deepEqual(choice,{selectedCandidateId:"mission-id:b",modelId:"fixture-model-v1",tokenUsage:{inputTokens:13,outputTokens:5}});
});

test("failed durable pre-dispatch record prevents advice dispatch",async()=>{
  const {store,mission}=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],1);let calls=0;
  store.recordSchedulingDecision=async()=>{throw new Error("event store unavailable");};
  const governor=new MissionGovernor(store,config,undefined,async()=>{calls++;return result(`${mission.id}:b`);});const grant=await governor.claim();assert(grant);assert.equal(grant.slice.id,"a");assert.equal(calls,0);
  const claim=(await store.events(mission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal(claim.data.schedulingDecisionId,null);assert.equal(claim.data.schedulingAdvice,null);
});

test("PGlite snapshots expose only exact promoted lesson provenance and stale withdrawal falls back",async()=>{
  const db=new PGlite();
  try{
    for(const file of ["001_initial.sql","002_missions.sql","003_recovery.sql","004_verification.sql","005_learning.sql"])await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
    let gate=Promise.resolve();const sql:TransactionalSql={query:async(text,params)=>await db.query(text,params as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>release=resolve);await prior;try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
    const store=new SqlMissionStore(sql);await store.configureCapacity(2,evidence,future());const mission=await store.submit({repository:"owner/sql",baseSha,objective:"SQL choice",acceptance:["fresh fence"],budgetCents:500});
    await store.recommendPlan(mission.id,[slice("a","src/a.ts"),slice("b","src/b.ts")],"owner-session");await store.approvePlan(mission.id);
    const lessonId="11111111-1111-4111-8111-111111111111",challenge="e".repeat(64);
    await db.query("INSERT INTO operational_lessons(id,repository,cohort,from_check_id,strategy_id,rule,lesson_version,metric,direction,baseline_failed,baseline_observed,outcome_passed,outcome_observed,policy_version,policy_digest,status,evidence_event_ids,challenge_digest,proposed_by,independent_challenge_digest) VALUES($1,'owner/sql','src','check:unit','strategy:good','advisory rule',2,'trusted_check_pass_rate','increase',1,1,1,1,'v1',$2,'promoted','[]'::jsonb,$3,'controller',$3)",[lessonId,recovery,challenge]);
    await db.query("INSERT INTO operational_lessons(id,repository,cohort,from_check_id,strategy_id,rule,lesson_version,metric,direction,baseline_failed,baseline_observed,outcome_passed,outcome_observed,policy_version,policy_digest,status,evidence_event_ids,challenge_digest,proposed_by,independent_challenge_digest) VALUES($1,'other/repo','src','check:unit','strategy:bad','wrong repo',1,'trusted_check_pass_rate','increase',1,1,1,1,'v1',$2,'promoted','[]'::jsonb,$3,'controller',$3)",["22222222-2222-4222-8222-222222222222",recovery,"f".repeat(64)]);
    const snapshot=await store.schedulingSnapshot(policy,recovery, ["check:unit"]);assert.deepEqual(snapshot.choices[0]?.lessons,[{id:lessonId,version:2,challengeDigest:challenge,checkId:"check:unit",strategyId:"strategy:good",policyDigest:recovery}]);
    const governor=new MissionGovernor(store,config,undefined,async()=>{await db.query("UPDATE operational_lessons SET status='withdrawn',withdrawn_at=now() WHERE id=$1",[lessonId]);return result(`${mission.id}:b`);});
    const grant=await governor.claim();assert(grant);assert.equal(grant.slice.id,"a");
    const event=(await store.events(mission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal((event.data.schedulingAdvice as any).status,"stale_fallback");

    const noGrant=await store.submit({repository:"owner/no-grant",baseSha,objective:"lost slot",acceptance:["persist advice"],budgetCents:500});await store.recommendPlan(noGrant.id,[slice("only-a","src/a.ts"),slice("only-b","src/b.ts")],"owner-session");await store.approvePlan(noGrant.id);
    const noGrantGovernor=new MissionGovernor(store,config,undefined,async choices=>{const selected=choices.choices.find(x=>x.missionId===noGrant.id)!;assert(selected);await db.query("UPDATE capacity_slots SET evidence_expires_at=$1",[new Date(Date.now()-1000).toISOString()]);return result(`${selected.missionId}:${selected.sliceId}`);});
    assert.equal(await noGrantGovernor.claim(),null);const noGrantEvents=await store.events(noGrant.id,0),decisionEvents=noGrantEvents.filter(x=>x.type==="scheduling.decision");assert.equal(decisionEvents.length,3);assert.equal(decisionEvents.at(-1)!.data.phase,"no_lease");assert.equal(decisionEvents.at(-1)!.data.dispatchMayHaveOccurred,true);assert.equal(decisionEvents.at(-1)!.data.snapshotDigest,(decisionEvents[1]!.data.snapshotDigest));assert.equal(noGrantEvents.filter(x=>x.type==="slice.claimed").length,0);assert.equal((await store.getMission(noGrant.id))!.mission.reservedCents,0);

    await db.query("UPDATE mission_slices SET status='blocked' WHERE mission_id=$1",[noGrant.id]);await db.query("UPDATE mission_slices SET status='verified',lease_token_hash=NULL,capability_hash=NULL,lease_expires_at=NULL WHERE mission_id=$1 AND id='a'",[mission.id]);await db.query("UPDATE mission_slices SET status='blocked' WHERE mission_id=$1 AND id='b'",[mission.id]);await store.configureCapacity(6,evidence,future());

    const budgetMission=await store.submit({repository:"owner/budget",baseSha,objective:"fresh budget",acceptance:["deny overrun"],budgetCents:500});await store.recommendPlan(budgetMission.id,[slice("budget-a","src/a.ts"),slice("budget-b","src/b.ts")],"owner-session");await store.approvePlan(budgetMission.id);
    const budgetGovernor=new MissionGovernor(store,config,undefined,async choices=>{const selected=choices.choices.find(x=>x.missionId===budgetMission.id)!;assert(selected);await db.query("UPDATE missions SET budget_cents=50 WHERE id=$1",[budgetMission.id]);return result(`${selected.missionId}:${selected.sliceId}`);});
    assert.equal(await budgetGovernor.claim(),null);assert.equal((await store.getMission(budgetMission.id))!.mission.reservedCents,0);const budgetEvents=await store.events(budgetMission.id,0);assert.equal(budgetEvents.filter(x=>x.type==="scheduling.decision").at(-1)!.data.phase,"no_lease");assert.equal(budgetEvents.filter(x=>x.type==="slice.claimed").length,0);
    await db.query("UPDATE mission_slices SET status='blocked' WHERE mission_id=$1",[budgetMission.id]);

    const blocker=await store.submit({repository:"owner/scope",baseSha,objective:"unknown quarantine",acceptance:["retain active scope"],budgetCents:500});await store.recommendPlan(blocker.id,[slice("blocker","src/not-shared.ts")],"owner-session");await store.approvePlan(blocker.id);
    const blockerGrant=await new MissionGovernor(store,config).claim();assert(blockerGrant);assert.equal(blockerGrant.mission.id,blocker.id);
    const scopeMission=await store.submit({repository:"owner/scope",baseSha,objective:"fresh overlap",acceptance:["exclude conflicting scope"],budgetCents:500});await store.recommendPlan(scopeMission.id,[slice("shared","src/shared.ts"),slice("free","docs/free.md")],"owner-session");await store.approvePlan(scopeMission.id);
    const scopeGovernor=new MissionGovernor(store,config,undefined,async choices=>{const selected=choices.choices.find(x=>x.missionId===scopeMission.id&&x.sliceId==="shared")!;assert(selected);await db.query("UPDATE mission_slices SET status='unknown',lease_token_hash=NULL,capability_hash=NULL,lease_expires_at=NULL,scopes=$2::jsonb WHERE mission_id=$1 AND id='blocker'",[blocker.id,JSON.stringify(["src/shared.ts"])]);return result(`${selected.missionId}:${selected.sliceId}`);});
    const scopeGrant=await scopeGovernor.claim();assert(scopeGrant);assert.equal(scopeGrant.mission.id,scopeMission.id);assert.equal(scopeGrant.slice.id,"free");assert.equal((await store.getMission(blocker.id))!.slices.find(x=>x.id==="blocker")!.status,"unknown");const scopeEvents=(await store.events(scopeMission.id,0)).filter(x=>x.type==="slice.claimed");assert.equal(scopeEvents.length,1);assert.equal((scopeEvents[0]!.data.schedulingAdvice as any).status,"stale_fallback");assert.equal((await store.getMission(scopeMission.id))!.mission.reservedCents,100);

    const planMission=await store.submit({repository:"owner/plan",baseSha,objective:"fresh plan digest",acceptance:["stale plan advice"],budgetCents:500});await store.recommendPlan(planMission.id,[slice("a","src/a.ts"),slice("b","src/b.ts")],"owner-session");await store.approvePlan(planMission.id);
    const planGovernor=new MissionGovernor(store,config,undefined,async choices=>{const selected=choices.choices.find(x=>x.missionId===planMission.id&&x.sliceId==="b")!;assert(selected);await db.query("UPDATE mission_plans SET slices=jsonb_set(slices,'{0,objective}',to_jsonb('changed'::text)) WHERE mission_id=$1",[planMission.id]);return result(`${selected.missionId}:${selected.sliceId}`);});
    const planGrant=await planGovernor.claim();assert(planGrant);assert.equal(planGrant.mission.id,planMission.id);assert.equal(planGrant.slice.id,"a");const planEvent=(await store.events(planMission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal((planEvent.data.schedulingAdvice as any).status,"stale_fallback");assert.equal((await store.getMission(planMission.id))!.mission.reservedCents,100);
    await db.query("UPDATE mission_slices SET status='blocked' WHERE mission_id=$1 AND id='b'",[planMission.id]);

    const dependencyMission=await store.submit({repository:"owner/dependency",baseSha,objective:"fresh dependency",acceptance:["require verified dependency"],budgetCents:500});await store.recommendPlan(dependencyMission.id,[slice("parent","src/parent.ts"),slice("child","src/child.ts",["parent"]),slice("alternate","docs/alternate.md")],"owner-session");await store.approvePlan(dependencyMission.id);await db.query("UPDATE mission_slices SET status='verified' WHERE mission_id=$1 AND id='parent'",[dependencyMission.id]);await db.query("UPDATE mission_slices SET status='ready' WHERE mission_id=$1 AND id='child'",[dependencyMission.id]);
    const dependencyGovernor=new MissionGovernor(store,config,undefined,async choices=>{const selected=choices.choices.find(x=>x.missionId===dependencyMission.id&&x.sliceId==="child")!;assert(selected);await db.query("UPDATE mission_slices SET status='unknown' WHERE mission_id=$1 AND id='parent'",[dependencyMission.id]);return result(`${selected.missionId}:${selected.sliceId}`);});
    const dependencyGrant=await dependencyGovernor.claim();assert(dependencyGrant);assert.equal(dependencyGrant.mission.id,dependencyMission.id);assert.equal(dependencyGrant.slice.id,"alternate");assert.equal((await store.getMission(dependencyMission.id))!.slices.find(x=>x.id==="child")!.status,"ready");const dependencyEvent=(await store.events(dependencyMission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal((dependencyEvent.data.schedulingAdvice as any).status,"stale_fallback");assert.equal((await store.getMission(dependencyMission.id))!.mission.reservedCents,100);

    const race=await store.submit({repository:"owner/race",baseSha,objective:"two claims",acceptance:["serialize"],budgetCents:500});await store.recommendPlan(race.id,[slice("race-a","src/race-a.ts"),slice("race-b","src/race-b.ts")],"owner-session");await store.approvePlan(race.id);
    let release!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve);let arrivals=0;const racingGovernor=new MissionGovernor(store,config,undefined,async choices=>{const selected=choices.choices.find(x=>x.missionId===race.id)!;assert(selected);if(++arrivals===2)release();await barrier;return result(`${selected.missionId}:${selected.sliceId}`);});
    const raced=await Promise.all([racingGovernor.claim(),racingGovernor.claim()]);assert.equal(raced.filter(Boolean).length,2);assert.equal(new Set(raced.map(x=>x?.slice.id)).size,2);assert.equal(new Set(raced.map(x=>x?.capacitySlot)).size,2);const raceEvents=(await store.events(race.id,0)).filter(x=>x.type==="slice.claimed");assert.equal(raceEvents.length,2);assert.equal((await store.getMission(race.id))!.mission.reservedCents,200);
  }finally{await db.close();}
});
