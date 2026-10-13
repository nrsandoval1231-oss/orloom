import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionConflictError, SliceInput, scopesOverlap } from "../packages/contracts/src/mission.js";
import { startLeaseReconciler } from "../packages/governor/src/lease-reconciler.js";

const baseSha="a".repeat(40), evidenceDigest="b".repeat(64), future=()=>new Date(Date.now()+60_000).toISOString();
const slice=(id:string,scope:string,dependencies:string[]=[],budgetCents=100):SliceInput=>({id,objective:`do ${id}`,dependencies,owner:"core",scopes:[scope],checks:["check:unit"],budgetCents});

test("memory governor allows six disjoint same-owner slices and keeps verification/dependency gates closed",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(6,evidenceDigest,future());
  const mission=await store.submit({repository:"owner/repo",baseSha,objective:"bounded change",acceptance:["all slices independently verified"],budgetCents:600});
  await store.recommendPlan(mission.id,[slice("s1","src/1.ts"),slice("s2","src/2.ts"),slice("s3","src/3.ts"),slice("s4","src/4.ts"),slice("s5","src/5.ts"),slice("s6","src/6.ts"),slice("child","src/child.ts",["s1"],0)],"owner-session");
  await store.approvePlan(mission.id);
  const grants=await Promise.all(Array.from({length:6},()=>store.claim(300,"c".repeat(64))));
  assert.equal(grants.filter(Boolean).length,6);
  assert.equal(new Set(grants.map(x=>x?.capacitySlot)).size,6);
  assert.equal(await store.claim(300,"c".repeat(64)),null);
  const first=grants[0]!;
  await store.complete(mission.id,first.slice.id,first.epoch,first.leaseToken,first.capabilityToken,"d".repeat(40),["worker://untrusted"]);
  assert.equal((await store.getMission(mission.id))?.slices.find(x=>x.id==="child")?.status,"waiting_dependency");
  await assert.rejects(store.integrate(mission.id,first.slice.id,"d".repeat(40),"c".repeat(64),["fake-check"],"fake-integration","fake-verifier"),MissionConflictError);
  assert.equal((await store.getMission(mission.id))?.slices.find(x=>x.id===first.slice.id)?.status,"awaiting_verification");
  await assert.rejects(store.complete(mission.id,first.slice.id,first.epoch,first.leaseToken,first.capabilityToken,"d".repeat(40),[]),MissionConflictError);
  assert.equal((await store.getMission(mission.id))?.slices.find(x=>x.id==="child")?.status,"waiting_dependency");
  const events=await store.events(mission.id,0);assert(events.some(e=>e.type==="slice.awaiting_verification"));assert(!events.some(e=>e.type==="slice.verified_integrated"));
});

test("scope ancestors and globs serialize; expired UNKNOWN retains budget and quarantines slot and scope",async()=>{
  assert.equal(scopesOverlap("docs/*.md","src/file.ts"),true);
  const store=new MemoryMissionStore();await store.configureCapacity(2,evidenceDigest,future());
  const m=await store.submit({repository:"owner/repo",baseSha,objective:"scope",acceptance:["checks"],budgetCents:300});
  await store.recommendPlan(m.id,[slice("parent","src"),slice("child","src/a.ts")],"owner-session");await store.approvePlan(m.id);
  const first=await store.claim(30,"c".repeat(64));assert(first);
  const second=await store.claim(30,"c".repeat(64));assert.equal(second,null);
  const unknown=first;
  const before=(await store.getMission(m.id))!.mission.reservedCents;
  await store.expire(new Date(Date.now()+40_000));
  assert.equal((await store.getMission(m.id))!.mission.reservedCents,before);
  assert.equal((await store.getMission(m.id))!.slices.find(s=>s.id===unknown.slice.id)?.status,"unknown");
  const retry=await store.claim(30,"c".repeat(64));assert.equal(retry,null);
  await assert.rejects(store.heartbeat(m.id,unknown.slice.id,unknown.epoch,unknown.leaseToken,unknown.capabilityToken,30),MissionConflictError);
});

test("dependency wait does not block overlapping parent and mixed-case repositories still serialize",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(2,evidenceDigest,future());
  const parentMission=await store.submit({repository:"Owner/Repo",baseSha,objective:"parent",acceptance:["verified"],budgetCents:200});
  await store.recommendPlan(parentMission.id,[slice("parent","src"),slice("child","src/child.ts",["parent"])],"owner-session");await store.approvePlan(parentMission.id);
  assert.equal((await store.getMission(parentMission.id))!.slices.find(x=>x.id==="child")!.status,"waiting_dependency");
  const parent=await store.claim(300,"c".repeat(64));assert(parent);assert.equal(parent.slice.id,"parent");assert.equal(parent.mission.repository,"owner/repo");
  const other=await store.submit({repository:"OWNER/REPO",baseSha,objective:"overlap",acceptance:["serialized"],budgetCents:100});
  await store.recommendPlan(other.id,[slice("other","src/child.ts")],"owner-session");await store.approvePlan(other.id);
  assert.equal(await store.claim(300,"c".repeat(64)),null);
  await store.complete(parentMission.id,parent.slice.id,parent.epoch,parent.leaseToken,parent.capabilityToken,"d".repeat(40),["candidate://ref"]);
  assert.equal((await store.getMission(parentMission.id))!.mission.status,"awaiting_verification");
  assert.equal(await store.claim(300,"c".repeat(64)),null);
});

test("PostgreSQL mission SQL persists dependency wait and reconciles expired leases after restart",async()=>{
  const db=new PGlite();await db.exec(await readFile("db/migrations/001_initial.sql","utf8"));await db.exec(await readFile("db/migrations/002_missions.sql","utf8"));
  let gate=Promise.resolve();
  const sql:TransactionalSql={query:async(text,params)=>await db.query(text,params as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>release=resolve);await prior;try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
  try{
    const a=new SqlMissionStore(sql),b=new SqlMissionStore(sql);await a.configureCapacity(3,evidenceDigest,future());
    const m=await a.submit({repository:"owner/repo",baseSha,objective:"sql",acceptance:["verified"],budgetCents:400});
    await a.recommendPlan(m.id,[slice("one","src/one.ts"),slice("two","src/two.ts"),slice("three","src/three.ts"),slice("blocked","src/blocked.ts",["one"])],"owner-session");await a.approvePlan(m.id);
    const grants=await Promise.all([a.claim(300,"c".repeat(64)),b.claim(300,"c".repeat(64)),a.claim(300,"c".repeat(64))]);assert(grants[0]&&grants[1]&&grants[2]);assert.equal(new Set(grants.map(x=>x!.slice.id)).size,3);
    const g=grants[0]!;await a.complete(m.id,g.slice.id,g.epoch,g.leaseToken,g.capabilityToken,"e".repeat(40),["untrusted://candidate"]);
    const stillRunning=grants[1]!,alsoRunning=grants[2]!;const reservedBefore=(await a.getMission(m.id))!.mission.reservedCents;
    await db.query("UPDATE mission_slices SET lease_expires_at=now()-interval '1 second' WHERE mission_id=$1 AND id=ANY($2::text[])",[m.id,[stillRunning.slice.id,alsoRunning.slice.id]]);
    const restartedStore=new SqlMissionStore(sql);const stop=await startLeaseReconciler(restartedStore,{intervalMs:60_000,batchSize:1});
    try {assert.equal((await b.getMission(m.id))!.mission.reservedCents,reservedBefore);const afterFirstSweep=(await b.getMission(m.id))!.slices;assert.equal(afterFirstSweep.filter(s=>s.status==="unknown").length,1);assert.equal(afterFirstSweep.filter(s=>s.status==="running").length,1);assert.equal(await restartedStore.expire(),1);assert.equal((await b.getMission(m.id))?.slices.find(s=>s.id===stillRunning.slice.id)?.status,"unknown");await assert.rejects(a.complete(m.id,stillRunning.slice.id,stillRunning.epoch,stillRunning.leaseToken,stillRunning.capabilityToken,"f".repeat(40),[]),MissionConflictError);}
    finally {await stop();}
    assert.equal((await b.getMission(m.id))?.slices.find(s=>s.id===g.slice.id)?.status,"awaiting_verification");
    assert.equal((await b.getMission(m.id))?.slices.find(s=>s.id==="blocked")?.status,"waiting_dependency");
    const replay=await b.events(m.id,0);assert(replay.some(e=>e.type==="slice.awaiting_verification"));assert(replay.some(e=>e.type==="slice.lease_expired_unknown"));assert.deepEqual(await b.events(m.id,replay.at(-1)!.cursor),[]);
    assert.equal((await b.getMission(m.id))!.mission.status,"unknown");
  }finally{await db.close();}
});

test("PostgreSQL claim permits an overlapping dependency parent but serializes mixed-case repository identity",async()=>{
  const db=new PGlite();await db.exec(await readFile("db/migrations/001_initial.sql","utf8"));await db.exec(await readFile("db/migrations/002_missions.sql","utf8"));
  let gate=Promise.resolve();const sql:TransactionalSql={query:async(text,params)=>await db.query(text,params as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>release=resolve);await prior;try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
  try{
    const store=new SqlMissionStore(sql);await store.configureCapacity(2,evidenceDigest,future());
    const a=await store.submit({repository:"Owner/Repo",baseSha,objective:"parent",acceptance:["serialized"],budgetCents:200});await store.recommendPlan(a.id,[slice("parent","src"),slice("child","src/child.ts",["parent"])],"owner-session");await store.approvePlan(a.id);
    const parent=await store.claim(300,"c".repeat(64));assert(parent);assert.equal(parent.slice.id,"parent");assert.equal(parent.mission.repository,"owner/repo");assert.equal((await store.getMission(a.id))!.slices.find(x=>x.id==="child")!.status,"waiting_dependency");
    const b=await store.submit({repository:"OWNER/REPO",baseSha,objective:"case overlap",acceptance:["serialize"],budgetCents:100});await store.recommendPlan(b.id,[slice("other","src/child.ts")],"owner-session");await store.approvePlan(b.id);
    assert.equal(await store.claim(300,"c".repeat(64)),null);
    await store.complete(a.id,parent.slice.id,parent.epoch,parent.leaseToken,parent.capabilityToken,"d".repeat(40),["candidate://ref"]);
    assert.equal((await store.getMission(a.id))!.mission.status,"awaiting_verification");
    assert.equal(await store.claim(300,"c".repeat(64)),null);
  }finally{await db.close();}
});

test("mission migration allows explicit dependency wait and is idempotent",async()=>{
  const db=new PGlite();
  try{
    await db.exec(await readFile("db/migrations/001_initial.sql","utf8"));
    const current=await readFile("db/migrations/002_missions.sql","utf8");
    await db.exec(current);await db.exec(current);
    const id="11111111-1111-4111-8111-111111111111";
    await db.query("INSERT INTO missions(id,repository,base_sha,objective,acceptance,budget_cents,status) VALUES($1,'owner/repo',$2,'mission',$3::jsonb,10,'planning')",[id,baseSha,JSON.stringify(["ok"])]);
    await db.query("INSERT INTO mission_slices(mission_id,id,objective,dependencies,owner,scopes,checks,budget_cents,status) VALUES($1,'child','child',$2::jsonb,'core',$3::jsonb,$4::jsonb,1,'waiting_dependency')",[id,JSON.stringify(["root"]),JSON.stringify(["src/child"]),JSON.stringify(["check:unit"])]);
    const got=await db.query("SELECT status FROM mission_slices WHERE mission_id=$1 AND id='child'",[id]);assert.equal((got.rows[0] as Record<string,unknown> | undefined)?.status,"waiting_dependency");
    await assert.rejects(db.query("UPDATE mission_slices SET status='not-a-state' WHERE mission_id=$1 AND id='child'",[id]));
  }finally{await db.close();}
});
