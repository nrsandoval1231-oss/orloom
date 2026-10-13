import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionGovernor } from "../packages/governor/src/governor.js";
import { createJevSchedulingAdapter } from "../packages/judgment/src/jev-adapter.js";
import type { SliceInput } from "../packages/contracts/src/mission.js";

const policy="c".repeat(64),recovery="d".repeat(64),baseSha="a".repeat(40),evidence="b".repeat(64);
const future=()=>new Date(Date.now()+60_000).toISOString();
const slice=(id:string,scope:string,deps:string[]=[],budget=100):SliceInput=>({id,objective:id,dependencies:deps,owner:"core",scopes:[scope],checks:["check:unit"],budgetCents:budget});
const config={maxLanes:6,capacitySlots:6,leaseSeconds:300,trustedCheckPolicyDigest:policy,recoveryPolicyDigest:recovery,trustedCheckPolicy:["check:unit"],executionConfigured:true};

async function memoryPlan(slices:SliceInput[],capacity=6,budget=10_000){
  const store=new MemoryMissionStore();await store.configureCapacity(capacity,evidence,future());
  const mission=await store.submit({repository:"owner/scheduler",baseSha,objective:"scheduling acceptance",acceptance:["one valid lease"],budgetCents:budget});
  await store.recommendPlan(mission.id,slices,"owner-session");await store.approvePlan(mission.id);return{store,mission};
}

test("memory scheduling ranks critical path and applies validated advice only at fresh claim",async()=>{
  const {store,mission}=await memoryPlan([slice("a-root","src/a.ts"),slice("a-child","src/a-child.ts",["a-root"]),slice("a-leaf","src/a-leaf.ts",["a-child"]),slice("z-independent","docs/z.md")],2);
  const snapshot=await store.schedulingSnapshot!(policy,recovery);
  assert.equal(snapshot.choices[0]?.sliceId,"a-root","longest remaining dependency path leads the deterministic rank");
  let calls=0;const governor=new MissionGovernor(store,config,undefined,async choices=>{calls++;return `${mission.id}:z-independent`;});
  const grant=await governor.claim();assert(grant);assert.equal(grant.slice.id,"z-independent");assert.equal(calls,1);
  const event=(await store.events(mission.id,0)).find(x=>x.type==="slice.claimed")!;assert.deepEqual(event.data.schedulingAdvice,{status:"selected",adviceStatus:"selected",dispatchMayHaveOccurred:false,preferredCandidateId:`${mission.id}:z-independent`,snapshotDigest:snapshot.snapshotDigest});
  assert.equal((await store.getMission(mission.id))?.mission.reservedCents,100);
});

test("advice is skipped for zero or one eligible choice and Jev context is capped at 32",async()=>{
  const zero=await memoryPlan([slice("parent","src/parent.ts"),slice("child","src/child.ts",["parent"])],1);assert(await zero.store.claim(300,policy));
  const empty=await zero.store.schedulingSnapshot!(policy,recovery);assert.equal(empty.choices.length,0);
  let zeroCalls=0;const emptyGovernor=new MissionGovernor(zero.store,config,undefined,async()=>{zeroCalls++;return "unused";});assert.equal(await emptyGovernor.claim(),null);assert.equal(zeroCalls,0);
  const one=await memoryPlan([slice("only","src/only.ts")],1);let calls=0;
  const governor=new MissionGovernor(one.store,config,undefined,async()=>{calls++;return `${one.mission.id}:only`;});
  assert.equal((await governor.claim())?.slice.id,"only");assert.equal(calls,0);
  const many=await memoryPlan(Array.from({length:36},(_,i)=>slice(`slice-${String(i).padStart(2,"0")}`,`src/${i}.ts`)),6,10_000);
  const snapshot=await many.store.schedulingSnapshot!(policy,recovery);assert.equal(snapshot.choices.length,32);
  assert.deepEqual(snapshot.choices.map(x=>x.sliceId),[...snapshot.choices.map(x=>x.sliceId)].sort());
});

test("memory concurrent claims fence stale advice and preserve deterministic fallback after UNKNOWN",async()=>{
  const {store,mission}=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],2);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
  const governor=new MissionGovernor(store,config,undefined,async snapshot=>{calls++;await gate;return `${mission.id}:${snapshot.choices.at(-1)!.sliceId}`;});
  const one=governor.claim(),two=governor.claim();await new Promise(resolve=>setTimeout(resolve,0));release();
  const grants=await Promise.all([one,two]);assert.equal(new Set(grants.filter(Boolean).map(x=>x!.slice.id)).size,2);assert.equal(calls,2);
  const claimEvents=(await store.events(mission.id,0)).filter(x=>x.type==="slice.claimed");assert.equal(claimEvents.length,2);assert(claimEvents.some(x=>(x.data.schedulingAdvice as any)?.status==="stale_fallback"));

  const fallback=await memoryPlan([slice("a","src/a.ts"),slice("b","src/b.ts")],1);
  let failedCalls=0;const failedGovernor=new MissionGovernor(fallback.store,config,undefined,async()=>{failedCalls++;throw new Error("post-dispatch UNKNOWN");});
  const safe=await failedGovernor.claim();assert(safe);assert.equal(safe.slice.id,"a");assert.equal(failedCalls,1);
  const recorded=(await fallback.store.events(fallback.mission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal((recorded.data.schedulingAdvice as any).status,"unknown");assert.equal((recorded.data.schedulingAdvice as any).dispatchMayHaveOccurred,true);
});

test("finite Jev adapter rejects oversized context before transport and emits no arbitrary action",async()=>{
  let transports=0;const fake={choose:async()=>{transports++;return{choice:"slice_1",model:"fixture",usage:{inputTokens:1,outputTokens:1},confidence:1};}};
  const adapter=createJevSchedulingAdapter(fake as never);
  const snapshot={capturedAt:new Date().toISOString(),freeCapacity:2,snapshotDigest:"f".repeat(64),choices:Array.from({length:32},(_,i)=>({missionId:"m".repeat(900),sliceId:`s${i}`,repository:"owner/repo",planDigest:"e".repeat(64),dependencies:[],scopes:[],budgetCents:1,missionBudgetCents:100,reservedBudgetCents:0,downstreamDepth:0,scopeRisk:0,lessons:[]}))};
  await assert.rejects(adapter(snapshot));assert.equal(transports,0);
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
    const snapshot=await store.schedulingSnapshot(policy,recovery);assert.deepEqual(snapshot.choices[0]?.lessons,[{id:lessonId,version:2,challengeDigest:challenge,checkId:"check:unit",strategyId:"strategy:good",policyDigest:recovery}]);
    await db.query("UPDATE operational_lessons SET status='withdrawn',withdrawn_at=now() WHERE id=$1",[lessonId]);
    const stale={status:"selected" as const,preferredCandidateId:`${mission.id}:b`,snapshotDigest:snapshot.snapshotDigest};
    const grant=await store.claim(300,policy,new Date(),recovery,stale);assert(grant);assert.equal(grant.slice.id,"a");
    const event=(await store.events(mission.id,0)).find(x=>x.type==="slice.claimed")!;assert.equal((event.data.schedulingAdvice as any).status,"stale_fallback");
  }finally{await db.close();}
});
