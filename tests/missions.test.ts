import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionConflictError, ProgressV1, SliceInput, TrustedStrategyPolicy, scopesOverlap } from "../packages/contracts/src/mission.js";
import { startLeaseReconciler } from "../packages/governor/src/lease-reconciler.js";
import type { DecisionSnapshotV1, JudgmentV1 } from "../packages/judgment/src/types.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { createHash } from "node:crypto";
import { eligibleLessonPair, lessonEpisodeKey, type LessonEpisodeObservation } from "../packages/learning/src/lesson-policy.js";

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

test("memory recovery fences terminal judgments and excludes cross-target lesson pairs",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(2,evidenceDigest,future());
  const policyDigest="c".repeat(64),recoveryDigest="e".repeat(64);
  const m=await store.submit({repository:"owner/recovery",baseSha,objective:"memory policy parity",acceptance:["fenced"],budgetCents:1000});
  const recoverySlice=(id:string):SliceInput=>({id,objective:id,dependencies:[],owner:"core",scopes:[`src/${id}.ts`],checks:["strategy:baseline","strategy:recovery"],budgetCents:100});
  await store.recommendPlan(m.id,[recoverySlice("one"),recoverySlice("two")],"owner-session");await store.approvePlan(m.id);
  const leases=await Promise.all([store.claim(300,policyDigest,new Date(),recoveryDigest),store.claim(300,policyDigest,new Date(),recoveryDigest)]);
  assert(leases[0]&&leases[1]);
  const strategies:Record<string,TrustedStrategyPolicy>={
    "strategy:baseline":{checkId:"check:baseline",version:"v1",expectedSignal:"target A fails",scopeClasses:["src"],targetCheckIds:["target:a"]},
    "strategy:recovery":{checkId:"check:recovery",version:"v1",expectedSignal:"recovery check passes",scopeClasses:["src"],targetCheckIds:["target:a","target:b"]},
  };
  const makeProgress=(lease:NonNullable<typeof leases[number]>,eventId:string,ordinal:number,strategyId:string,status:ProgressV1["status"],targetCheckId:string,reasonCode:ProgressV1["reasonCode"]):ProgressV1=>({
    version:"orloom.progress.v1",eventId,missionId:m.id,sliceId:lease.slice.id,leaseEpoch:lease.epoch,ordinal,planDigest:lease.planDigest,
    trustedCheckPolicyDigest:policyDigest,recoveryPolicyDigest:recoveryDigest,phase:"trusted_check",status,reasonCode,strategyId,targetCheckId,
    checkId:strategies[strategyId]!.checkId,counters:{providerCalls:0,inputTokens:0,outputTokens:0,wallMs:1},evidenceRefs:[`sha256:${"f".repeat(64)}`],
  });
  const leaseA=leases[0],leaseB=leases[1];if(!leaseA||!leaseB)throw new Error("expected two independent memory leases");
  for(const [index,lease] of [leaseA,leaseB].entries()){
    const failed=makeProgress(lease,`fail-${index}`,1,"strategy:baseline","failed","target:a","check_failed");
    await assert.rejects(store.recordProgress(failed,lease.leaseToken,lease.capabilityToken,strategies),MissionConflictError,"memory storage cannot authorize worker-asserted terminal observations");
  }
  assert.deepEqual(await store.lessons(m.id),[],"untrusted terminal worker reports cannot create memory lesson candidates");

  const terminalStore=new MemoryMissionStore();await terminalStore.configureCapacity(1,evidenceDigest,future());
  const terminalMission=await terminalStore.submit({repository:"owner/terminal",baseSha,objective:"terminal reports",acceptance:["quarantine"],budgetCents:100});
  await terminalStore.recommendPlan(terminalMission.id,[recoverySlice("terminal")],"owner-session");await terminalStore.approvePlan(terminalMission.id);
  const terminalLease=await terminalStore.claim(300,policyDigest,new Date(),recoveryDigest);assert(terminalLease);
  const terminalProgress=(status:"blocked"|"unknown",eventId:string):ProgressV1=>({
    version:"orloom.progress.v1",eventId,missionId:terminalMission.id,sliceId:terminalLease.slice.id,leaseEpoch:terminalLease.epoch,ordinal:1,planDigest:terminalLease.planDigest,
    trustedCheckPolicyDigest:policyDigest,recoveryPolicyDigest:recoveryDigest,phase:"trusted_check",status,reasonCode:status==="blocked"?"scope_conflict":"provider_unavailable",
    strategyId:"strategy:baseline",targetCheckId:"target:a",checkId:"check:baseline",counters:{providerCalls:0,inputTokens:0,outputTokens:0,wallMs:1},evidenceRefs:[`sha256:${"f".repeat(64)}`],
  });
  const before=(await terminalStore.getMission(terminalMission.id))!.mission.reservedCents;
  const blockedReceipt=await terminalStore.recordProgress(terminalProgress("blocked","blocked-event"),terminalLease.leaseToken,terminalLease.capabilityToken,strategies);
  assert.equal(blockedReceipt.action.action,"escalate");
  assert.equal((await terminalStore.getMission(terminalMission.id))!.slices[0]!.status,"blocked");
  assert.equal((await terminalStore.getMission(terminalMission.id))!.mission.reservedCents,before);

  const unknownStore=new MemoryMissionStore();await unknownStore.configureCapacity(1,evidenceDigest,future());
  const unknownMission=await unknownStore.submit({repository:"owner/unknown",baseSha,objective:"unknown reports",acceptance:["quarantine"],budgetCents:100});
  await unknownStore.recommendPlan(unknownMission.id,[recoverySlice("unknown")],"owner-session");await unknownStore.approvePlan(unknownMission.id);
  const unknownLease=await unknownStore.claim(300,policyDigest,new Date(),recoveryDigest);assert(unknownLease);
  const unknown=terminalProgress("unknown","unknown-event");unknown.missionId=unknownMission.id;unknown.sliceId=unknownLease.slice.id;unknown.leaseEpoch=unknownLease.epoch;unknown.planDigest=unknownLease.planDigest;
  const continueJudge=async(snapshot:DecisionSnapshotV1):Promise<JudgmentV1>=>({version:"orloom.judgment.v1",snapshotDigest:createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),source:"jev",answer:"continue",strategyId:null,checkId:null,policyVersion:"v1",policyDigest:recoveryDigest,modelId:"fixture-model",confidence:1,usage:{inputTokens:0,outputTokens:0}});
  const unknownBefore=(await unknownStore.getMission(unknownMission.id))!.mission.reservedCents;
  await assert.rejects(unknownStore.recordProgress(unknown,unknownLease.leaseToken,unknownLease.capabilityToken,strategies,continueJudge),MissionConflictError);
  assert.equal((await unknownStore.getMission(unknownMission.id))!.slices[0]!.status,"unknown");
  assert.equal((await unknownStore.getMission(unknownMission.id))!.mission.reservedCents,unknownBefore);
});

test("memory two-phase judgment quarantines when mission reservation changes after snapshot",async()=>{
  const store=new MemoryMissionStore();await store.configureCapacity(2,evidenceDigest,future());
  const policyDigest="c".repeat(64),recoveryDigest="e".repeat(64);
  const m=await store.submit({repository:"owner/snapshot-fence",baseSha,objective:"stale budget context",acceptance:["fenced"],budgetCents:1000});
  await store.recommendPlan(m.id,[slice("first","src/first.ts",[],100),slice("second","src/second.ts",[],100)],"owner-session");await store.approvePlan(m.id);
  const first=await store.claim(300,policyDigest,new Date(),recoveryDigest);assert(first);
  const strategies:Record<string,TrustedStrategyPolicy>={"check:unit":{checkId:"check:unit",version:"v1",expectedSignal:"starts",scopeClasses:["src"],targetCheckIds:["target:unit"]}};
  const p:ProgressV1={version:"orloom.progress.v1",eventId:"budget-fence-event",missionId:m.id,sliceId:first.slice.id,leaseEpoch:first.epoch,ordinal:1,planDigest:first.planDigest,trustedCheckPolicyDigest:policyDigest,recoveryPolicyDigest:recoveryDigest,phase:"trusted_check",status:"started",reasonCode:"other",strategyId:"check:unit",targetCheckId:"target:unit",checkId:"check:unit",counters:{providerCalls:0,inputTokens:0,outputTokens:0,wallMs:1},evidenceRefs:[`sha256:${"a".repeat(64)}`]};
  let release!: (judgment:JudgmentV1)=>void;let signalStarted!:()=>void;
  const started=new Promise<void>(resolve=>signalStarted=resolve);
  const pendingJudgment=new Promise<JudgmentV1>(resolve=>release=resolve);
  let captured:DecisionSnapshotV1|undefined;
  const pending=store.recordProgress(p,first.leaseToken,first.capabilityToken,strategies,async(snapshot)=>{captured=snapshot;signalStarted();return pendingJudgment;});
  await started;
  assert.equal(captured?.reservedBudgetCents,100);
  const second=await store.claim(300,policyDigest,new Date(),recoveryDigest);assert(second);
  release({version:"orloom.judgment.v1",snapshotDigest:createHash("sha256").update(canonicalJson(captured)).digest("hex"),source:"deterministic",answer:"continue",strategyId:null,checkId:null,policyVersion:"v1",policyDigest:recoveryDigest,modelId:null,confidence:null,usage:null});
  await assert.rejects(pending,MissionConflictError);
  const after=await store.getMission(m.id);assert(after);
  assert.equal(after.slices.find(x=>x.id===first.slice.id)?.status,"unknown");
  assert.equal(after.mission.reservedCents,200,"both lease reservations remain held after stale judgment quarantine");
});

test("memory lesson candidates require two committed same-cohort episodes",async()=>{
  const policyDigest="c".repeat(64),recoveryDigest="e".repeat(64);
  const strategies:Record<string,TrustedStrategyPolicy>={
    "strategy:baseline":{checkId:"check:baseline",version:"v1",expectedSignal:"baseline",scopeClasses:["*"],targetCheckIds:["target:unit"]},
    "strategy:recovery":{checkId:"check:recovery",version:"v1",expectedSignal:"recovery",scopeClasses:["*"],targetCheckIds:["target:unit"]},
  };
  const run=async(scopes:string[][])=>{
    const store=new MemoryMissionStore();await store.configureCapacity(scopes.length,evidenceDigest,future());
    const mission=await store.submit({repository:"owner/lesson",baseSha,objective:"cohort eligibility",acceptance:["committed comparable episodes"],budgetCents:1000});
    const inputs:SliceInput[]=scopes.map((paths,index)=>({id:`slice-${index}`,objective:`slice ${index}`,dependencies:[],owner:"core",scopes:paths,checks:["strategy:baseline","strategy:recovery"],budgetCents:100}));
    await store.recommendPlan(mission.id,inputs,"owner-session");await store.approvePlan(mission.id);
    const leases=await Promise.all(scopes.map(()=>store.claim(300,policyDigest,new Date(),recoveryDigest)));
    assert(leases.every(Boolean));
    const makeProgress=(lease:NonNullable<typeof leases[number]>,eventId:string,ordinal:number,strategyId:string,status:ProgressV1["status"]):ProgressV1=>({
      version:"orloom.progress.v1",eventId,missionId:mission.id,sliceId:lease.slice.id,leaseEpoch:lease.epoch,ordinal,planDigest:lease.planDigest,
      trustedCheckPolicyDigest:policyDigest,recoveryPolicyDigest:recoveryDigest,phase:"trusted_check",status,
      reasonCode:status==="failed"?"check_failed":"check_passed",strategyId,targetCheckId:"target:unit",checkId:strategies[strategyId]!.checkId,
      counters:{providerCalls:0,inputTokens:0,outputTokens:0,wallMs:1},evidenceRefs:[`sha256:${"f".repeat(64)}`],
    });
    for(let index=0;index<leases.length;index++){
      const lease=leases[index];assert(lease);
      const failed=makeProgress(lease,`failure-${index}`,1,"strategy:baseline","failed");
      await assert.rejects(store.recordProgress(failed,lease.leaseToken,lease.capabilityToken,strategies),MissionConflictError);
      const passed=makeProgress(lease,`success-${index}`,2,"strategy:recovery","passed");
      await assert.rejects(store.recordProgress(passed,lease.leaseToken,lease.capabilityToken,strategies),MissionConflictError,"a worker-reported PASS cannot create a candidate, even for a same-cohort pair");
    }
    return store.lessons(mission.id);
  };

  assert.deepEqual(await run([["src/unknown.ts"],["src/valid.ts"]]),[]);
  assert.deepEqual(await run([["src/valid.ts"],["src/unknown.ts"]]),[]);
  assert.deepEqual(await run([["src/one.ts"],["docs/two.md"]]),[]);
  const sameCohort=await run([["src/z","docs/a"],["docs/b","src/y"]]);
  assert.deepEqual(sameCohort,[],"in-memory test data cannot substitute for trusted terminal attempts to create candidates");
});

test("lesson episode count deduplicates epochs but pairs evidence only within one epoch",()=>{
  const observation=(leaseEpoch:number):LessonEpisodeObservation=>({eventId:`event-${leaseEpoch}`,repository:"owner/repo",missionId:"mission",sliceId:"slice",leaseEpoch,ordinal:1,status:"failed",decisionStatus:"committed",targetCheckId:"target",strategyId:"baseline",trustedCheckPolicyDigest:"a",recoveryPolicyDigest:"b",cohort:"src"});
  const epoch1=observation(1),epoch2={...observation(2),status:"passed",strategyId:"recovery",ordinal:2};
  assert.equal(lessonEpisodeKey(epoch1),lessonEpisodeKey(epoch2));
  assert.equal(eligibleLessonPair(epoch1,epoch2),false,"different lease epochs cannot form a failure/pass pair");
});

test("PostgreSQL mission SQL persists dependency wait and reconciles expired leases after restart",async()=>{
  const db=new PGlite();await db.exec(await readFile("db/migrations/001_initial.sql","utf8"));await db.exec(await readFile("db/migrations/002_missions.sql","utf8"));await db.exec(await readFile("db/migrations/003_recovery.sql","utf8"));
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
  const db=new PGlite();await db.exec(await readFile("db/migrations/001_initial.sql","utf8"));await db.exec(await readFile("db/migrations/002_missions.sql","utf8"));await db.exec(await readFile("db/migrations/003_recovery.sql","utf8"));
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
