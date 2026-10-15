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

test("memory pre-runtime settlement is idempotent and rejects late new runtime binding",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(1,sha("d"),new Date(Date.now()+300_000).toISOString());
  const mission=await store.submit({repository:"owner/repo",baseSha:"e".repeat(40),objective:"cancel before runtime",acceptance:["stop"],budgetCents:200});
  await store.recommendPlan(mission.id,[input],"owner");await store.approvePlan(mission.id);const lease=await store.claim(300,sha("f"),["check:unit"]);assert(lease);
  const identity:CancellationRuntimeIdentity={missionId:mission.id,sliceId:"slice",leaseEpoch:lease.epoch,controllerRunId:sha("1")};await store.requestCancel!(mission.id,"memory-stop-before-runtime","stop");
  await assert.rejects(store.registerCancellationRuntimeBinding!(identity,{name:"orloom-worker-slice",imageRef:`sha256:${sha("a")}`,labelsDigest:sha("b")}));
  assert.equal(await store.settleCancellationBeforeRuntime!(identity),"settled");assert.equal(await store.settleCancellationBeforeRuntime!(identity),"settled");
  assert.equal((await store.getMission(mission.id))!.mission.status,"cancelled");
});
