import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import type { CancellationRuntimeEntry, CancellationRuntimeIdentity } from "../packages/contracts/src/cancellation-settlement.js";
import type { SliceInput } from "../packages/contracts/src/mission.js";

const sha=(c:string)=>c.repeat(64), now=()=>new Date().toISOString();
function sql(db:PGlite):TransactionalSql{
  let tail=Promise.resolve();
  return {query:async(text,params)=>await db.query(text,params as never) as never,transaction:async<T>(work:(tx:{query:TransactionalSql["query"]})=>Promise<T>)=>{let release!:()=>void;const before=tail;tail=new Promise<void>(r=>release=r);return before.then(async()=>{try{await db.exec("BEGIN");const value=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return value;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}});}};
}
async function migrate(db:PGlite){for(const f of (await readdir("db/migrations")).filter(x=>x.endsWith(".sql")).sort())await db.exec(await readFile(`db/migrations/${f}`,"utf8"));}
const input:SliceInput={id:"slice",objective:"cancel safely",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100};
function evidence(identity:CancellationRuntimeIdentity,state:"unknown"|"absent",at:string,previousUnknown=false):CancellationRuntimeEntry{
  const observation={source:"orloom.trusted-docker-reconciler.v1" as const,outcome:state,identity:{...identity},name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b"),containerId:sha("c"),observedAt:at};
  const history=previousUnknown?[{state:"intent",at},{state:"created",at,containerId:sha("c")},{state:"unknown",at,observation:{...observation,outcome:"unknown" as const}},{state,at,observation}]:[{state:"intent",at},{state:"created",at,containerId:sha("c")},{state,at,observation}];
  return {version:"orloom.runtime-journal.v2",identity:{...identity},name:observation.name,imageRef:observation.imageRef,labelsDigest:observation.labelsDigest,containerId:observation.containerId,state,updatedAt:at,reconciliation:observation,history};
}

test("cancellation settlement requires exact bound absent runtime evidence and keeps spend reserved",async()=>{
  const db=new PGlite();
  try{
    await migrate(db);await migrate(db);
    const store=new SqlMissionStore(sql(db));await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"cancel safely",acceptance:["stop"],budgetCents:200});
    await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);
    const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
    const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
    const binding={name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")};
    await store.registerCancellationRuntimeBinding!(identity,binding);await store.bindCancellationRuntimeContainer!(identity,sha("c"));
    await store.requestCancel!(mission.id,"owner-stop","stop this slice");
    const reservedBefore=Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents);
    const free=async()=>Number(((await db.query("SELECT count(*)::int AS n FROM capacity_slots c WHERE c.enabled AND c.evidence_expires_at>now() AND NOT EXISTS(SELECT 1 FROM mission_slices s WHERE s.capacity_slot=c.slot_id AND s.status IN ('running','cancel_requested','unknown','blocked'))")).rows[0] as {n:unknown}).n);
    const at=now();
    const wrong=evidence({...identity,controllerRunId:sha("2")},"absent",at);
    assert.equal(await store.reconcileCancellationRuntime!(wrong),"ignored");
    const malformed={...evidence(identity,"unknown",at),reconciliation:{...evidence(identity,"unknown",at).reconciliation!,identity:null}} as unknown as CancellationRuntimeEntry;
    assert.equal(await store.reconcileCancellationRuntime!(malformed),"ignored","malformed evidence fails closed");
    assert.equal(await store.reconcileCancellationRuntime!(evidence(identity,"unknown",at)),"quarantined");
    assert.equal((await store.getMission(mission.id))!.slices[0]!.status,"cancel_requested");assert.equal(await free(),0);
    const exact=evidence(identity,"absent",at,true);
    assert.equal(await store.reconcileCancellationRuntime!(exact),"settled");
    assert.equal(await store.reconcileCancellationRuntime!(exact),"settled","replay is idempotent");
    const substituted={...exact,reconciliation:{...exact.reconciliation!,observedAt:new Date(Date.parse(at)+1).toISOString()}};
    assert.equal(await store.reconcileCancellationRuntime!(substituted),"ignored","a different proof cannot replay an already fenced settlement");
    const state=await store.getMission(mission.id);assert.equal(state!.slices[0]!.status,"cancelled");assert.equal(state!.mission.status,"cancelled");
    assert.equal(await free(),1);assert.equal(Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents),reservedBefore,"settlement never refunds uncertain spend");
  }finally{await db.close();}
});

test("a cancelled candidate awaiting verification settles only after exact runtime absence",async()=>{
  const db=new PGlite();
  try{
    await migrate(db);const store=new SqlMissionStore(sql(db));await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"cancel safely",acceptance:["stop"],budgetCents:200});
    await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
    const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
    await store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")});await store.bindCancellationRuntimeContainer!(identity,sha("c"));
    await store.complete(mission.id,"slice",lease.epoch,lease.leaseToken,lease.capabilityToken,"f".repeat(40),[]);
    assert.equal((await store.getMission(mission.id))!.slices[0]!.status,"awaiting_verification");
    await store.requestCancel!(mission.id,"owner-stop-candidate","stop before verification");
    assert.equal((await store.getMission(mission.id))!.mission.status,"cancelling");
    assert.equal(await store.reconcileCancellationRuntime!(evidence(identity,"absent",now())),"settled");
    const after=await store.getMission(mission.id);assert.equal(after!.slices[0]!.status,"cancelled");assert.equal(after!.mission.status,"cancelled");
  }finally{await db.close();}
});

test("normal exact runtime absence is retained without settling and can settle after a later cancellation",async()=>{
  const db=new PGlite();
  try{
    await migrate(db);const store=new SqlMissionStore(sql(db));await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"retain completed candidate",acceptance:["verify"],budgetCents:200});
    await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
    const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
    await store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")});await store.bindCancellationRuntimeContainer!(identity,sha("c"));
    await store.complete(mission.id,"slice",lease.epoch,lease.leaseToken,lease.capabilityToken,"f".repeat(40),[]);
    const proof=evidence(identity,"absent",now());
    const corrupt={...proof,history:[]} as unknown as CancellationRuntimeEntry;
    assert.equal(await store.reconcileCancellationRuntime!(corrupt),"quarantined","exact identity with invalid retained history is quarantined");
    const reservedBefore=Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents);
    assert.equal(await store.reconcileCancellationRuntime!(proof),"observed_absent");
    assert.equal(await store.reconcileCancellationRuntime!(evidence(identity,"unknown",now())),"quarantined","a later UNKNOWN remains quarantined after a valid absence observation");
    assert.equal((await store.getMission(mission.id))!.slices[0]!.status,"awaiting_verification");
    assert.equal((await store.getMission(mission.id))!.mission.status,"awaiting_verification");
    assert.equal(Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents),reservedBefore);
    await store.requestCancel!(mission.id,"owner-stop-after-completion","stop before verification");
    assert.equal(await store.reconcileCancellationRuntime!(proof),"settled","retained proof settles idempotently once the mission is cancelling");
    assert.equal((await store.getMission(mission.id))!.slices[0]!.status,"cancelled");
    assert.equal(Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents),reservedBefore);
  }finally{await db.close();}
});

test("verified slice runtime ABSENT evidence remains an idempotent observation",async()=>{
  const db=new PGlite();
  try{
    await migrate(db);const store=new SqlMissionStore(sql(db));await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"verified candidate",acceptance:["verify"],budgetCents:200});
    await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
    const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
    await store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")});await store.bindCancellationRuntimeContainer!(identity,sha("c"));
    await store.complete(mission.id,"slice",lease.epoch,lease.leaseToken,lease.capabilityToken,"f".repeat(40),[]);
    await db.query("UPDATE mission_slices SET status='verified' WHERE mission_id=$1 AND id='slice'",[mission.id]);await db.query("UPDATE missions SET status='verified' WHERE id=$1",[mission.id]);
    const proof=evidence(identity,"absent",now());
    assert.equal(await store.reconcileCancellationRuntime!(proof),"observed_absent");
    assert.equal(await store.reconcileCancellationRuntime!(proof),"observed_absent","exact retained proof replay remains benign after verified state");
    const after=await store.getMission(mission.id);assert.equal(after!.slices[0]!.status,"verified");assert.equal(after!.mission.status,"verified");assert.equal(after!.mission.reservedCents,100);
  }finally{await db.close();}
});

test("exact verification eligibility reaches candidates beyond the global scanner cap and honors terminal guards",async()=>{
  const db=new PGlite();
  try{
    await migrate(db);const store=new SqlMissionStore(sql(db));
    const mission=await store.submit({repository:"owner/backlog",baseSha:"e".repeat(40),objective:"verify backlog",acceptance:["checks"],budgetCents:500});
    const slices=Array.from({length:101},(_,i)=>({...input,id:`slice-${String(i).padStart(3,"0")}`,scopes:[`src/${i}.ts`],budgetCents:1}));
    await store.recommendPlan(mission.id,slices,"owner");await store.approvePlan(mission.id);
    await db.query("UPDATE mission_slices SET status='awaiting_verification',lease_epoch=1,candidate_sha=$2 WHERE mission_id=$1",[mission.id,"f".repeat(40)]);
    await db.query("UPDATE missions SET status='awaiting_verification' WHERE id=$1",[mission.id]);
    assert.equal((await store.awaitingVerification(["check:unit"],1000)).length,100,"legacy queue scanner stays bounded");
    const beyondCap=slices[100]!;
    assert.equal(await store.isVerificationDispatchEligible!(mission.id,beyondCap.id,1,["check:unit"]),true);
    await db.query("INSERT INTO verification_attempts(attempt_id,mission_id,slice_id,lease_epoch,check_id,request,capability_hash,capability_expires_at,request_digest,purpose,head_observed_at,head_observation_digest,lease_policy_digest) VALUES($1,$2,$3,1,'check:unit','{}'::jsonb,$4,now()+interval '1 hour',$5,'final',now(),$6,$7)",["11111111-1111-4111-8111-111111111111",mission.id,beyondCap.id,sha("c"),sha("d"),sha("e"),sha("f")]);
    assert.equal(await store.isVerificationDispatchEligible!(mission.id,beyondCap.id,1,["check:unit"]),false,"persisted final attempt remains terminal for eligibility");
    const failed=slices[99]!;
    await store.recordVerificationUnavailable(mission.id,failed.id,1,"check:unit","candidate_unavailable");
    assert.equal(await store.isVerificationDispatchEligible!(mission.id,failed.id,1,["check:unit"]),false,"durable dispatch failure remains terminal for eligibility");
    assert.equal(await store.isVerificationDispatchEligible!(mission.id,beyondCap.id,2,["check:unit"]),false,"stale epochs are never eligible");
  }finally{await db.close();}
});

test("pre-runtime cancellation settles atomically only when no binding exists",async()=>{
  const db=new PGlite();
  try{
    await migrate(db);const store=new SqlMissionStore(sql(db));await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"cancel before runtime",acceptance:["stop"],budgetCents:200});
    await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
    const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
    await store.requestCancel!(mission.id,"owner-stop-pre-runtime","stop before container intent");
    const reservedBefore=Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents);
    assert.equal(await store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")}).then(()=>"registered",()=>"refused"),"refused","cancellation fences a new runtime binding");
    assert.equal(await store.settleCancellationBeforeRuntime!(identity),"settled");assert.equal(await store.settleCancellationBeforeRuntime!(identity),"settled","pre-runtime settlement replay is idempotent");
    const after=await store.getMission(mission.id);assert.equal(after!.slices[0]!.status,"cancelled");assert.equal(after!.mission.status,"cancelled");
    assert.equal(Number(((await db.query("SELECT reserved_cents FROM missions WHERE id=$1",[mission.id])).rows[0] as {reserved_cents:unknown}).reserved_cents),reservedBefore);
    assert.equal(Number(((await db.query("SELECT count(*)::int AS n FROM cancellation_runtime_bindings WHERE mission_id=$1",[mission.id])).rows[0] as {n:unknown}).n),0);
  }finally{await db.close();}
});

test("memory settlement handles a candidate already awaiting verification",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
  const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"cancel safely",acceptance:["stop"],budgetCents:200});
  await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
  const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
  const binding={name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")};await store.registerCancellationRuntimeBinding!(identity,binding);await store.bindCancellationRuntimeContainer!(identity,sha("c"));
  await store.complete(mission.id,"slice",lease.epoch,lease.leaseToken,lease.capabilityToken,"f".repeat(40),[]);await store.requestCancel!(mission.id,"memory-stop-candidate","stop");
  assert.equal(await store.reconcileCancellationRuntime!(evidence(identity,"absent",now())),"settled");
  assert.equal((await store.getMission(mission.id))!.mission.status,"cancelled");
  const next=await store.submit({repository:"owner/next",baseSha:"e".repeat(40),objective:"use released lane",acceptance:["run"],budgetCents:200});
  await store.recommendPlan(next.id,[{...input,id:"next"}],"owner");await store.approvePlan(next.id);
  assert((await store.claim(300,sha("f"),["check:unit"])),"memory capacity is released after exact absence");
});

test("memory store retains normal exact ABSENT evidence until a later owner cancellation",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
  const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"retain proof",acceptance:["verify"],budgetCents:200});
  await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
  const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
  const binding={name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")};await store.registerCancellationRuntimeBinding!(identity,binding);await store.bindCancellationRuntimeContainer!(identity,sha("c"));
  await store.complete(mission.id,"slice",lease.epoch,lease.leaseToken,lease.capabilityToken,"f".repeat(40),[]);
  const proof=evidence(identity,"absent",now());
  assert.equal(await store.reconcileCancellationRuntime!(proof),"observed_absent");
  assert.equal((await store.getMission(mission.id))!.slices[0]!.status,"awaiting_verification");
  assert.equal((await store.getMission(mission.id))!.mission.reservedCents,100);
  await store.requestCancel!(mission.id,"memory-owner-after-completion","stop before verification");
  assert.equal(await store.reconcileCancellationRuntime!(proof),"settled");
  assert.equal((await store.getMission(mission.id))!.slices[0]!.status,"cancelled");
  assert.equal((await store.getMission(mission.id))!.mission.reservedCents,100);
});

test("memory store keeps an exact retained ABSENT observation benign after verified state",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
  const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"verified candidate",acceptance:["verify"],budgetCents:200});
  await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
  const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};
  await store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")});await store.bindCancellationRuntimeContainer!(identity,sha("c"));
  await store.complete(mission.id,"slice",lease.epoch,lease.leaseToken,lease.capabilityToken,"f".repeat(40),[]);
  const internals=store as unknown as {slices:Map<string,{status:string}>;missions:Map<string,{status:string}>};
  internals.slices.get(`${mission.id}:slice`)!.status="verified";internals.missions.get(mission.id)!.status="verified";
  const proof=evidence(identity,"absent",now());
  assert.equal(await store.reconcileCancellationRuntime!(proof),"observed_absent");assert.equal(await store.reconcileCancellationRuntime!(proof),"observed_absent");
  const after=await store.getMission(mission.id);assert.equal(after!.slices[0]!.status,"verified");assert.equal(after!.mission.status,"verified");assert.equal(after!.mission.reservedCents,100);
});

test("memory pre-runtime settlement is idempotent and rejects late new runtime binding",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
  const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"cancel before runtime",acceptance:["stop"],budgetCents:200});
  await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
  const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};await store.requestCancel!(mission.id,"memory-stop-before-runtime","stop");
  await assert.rejects(store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")}));
  assert.equal(await store.settleCancellationBeforeRuntime!(identity),"settled");assert.equal(await store.settleCancellationBeforeRuntime!(identity),"settled");
  assert.equal((await store.getMission(mission.id))!.mission.status,"cancelled");
});
