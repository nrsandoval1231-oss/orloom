import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionConflictError, type SliceInput } from "../packages/contracts/src/mission.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { receiptDigestV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const baseSha="a".repeat(40), candidateSha="d".repeat(40), policyDigest="c".repeat(64);
const slice:SliceInput={id:"source",objective:"verify candidate",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100};

test("PostgreSQL certification binds exact candidate, stores immutable certificate and event once",async()=>{
  const db=new PGlite();
  try{
    for(const path of ["001_initial.sql","002_missions.sql","003_recovery.sql","004_verification.sql"])await db.exec(await readFile(`db/migrations/${path}`,"utf8"));
    let gate=Promise.resolve();const sql:TransactionalSql={query:async(text,params)=>await db.query(text,params as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>release=resolve);await prior;try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
    const store=new SqlMissionStore(sql);await store.configureCapacity(1,"b".repeat(64),new Date(Date.now()+60_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha,objective:"certification fixture",acceptance:["persist exact evidence"],budgetCents:100});
    await store.recommendPlan(mission.id,[slice],"owner-session");await store.approvePlan(mission.id);
    const grant=await store.claim(300,policyDigest);assert(grant);await store.complete(mission.id,slice.id,grant.epoch,grant.leaseToken,grant.capabilityToken,candidateSha,[]);
    const record=await store.getMission(mission.id);assert(record?.plan);
    const now=new Date(),expires=new Date(now.getTime()+60_000);
    const request:TrustedCheckRequestV1={version:"orloom.trusted-check-request.v1",attemptId:"11111111-1111-4111-8111-111111111111",missionId:mission.id,sliceId:slice.id,leaseEpoch:grant.epoch,repository:"owner/repo",candidateSha,expectedLocalHeadSha:candidateSha,planDigest:hash(canonicalJson(record.plan.slices)),checkId:"check:unit",policyVersion:"v1",policyDigest,verifierImageDigest:"f".repeat(64),inputBundleDigest:"e".repeat(64),requestedAt:now.toISOString(),expiresAt:expires.toISOString()};
    const capabilityHash=hash("private-fixture-capability");await store.createVerificationAttempt!({request,capabilityHash,capabilityExpiresAt:new Date(expires.getTime()+120_000).toISOString(),leasePolicyDigest:policyDigest,headObservedAt:now.toISOString(),headObservationDigest:"9".repeat(64)});
    const artifact={key:`sha256/${"1".repeat(64)}` as `sha256/${string}`,sha256:"1".repeat(64),bytes:0};
    const manifest={...artifact,key:`sha256/${"2".repeat(64)}` as `sha256/${string}`,sha256:"2".repeat(64)};
    const body={version:"orloom.trusted-check-receipt.v1" as const,request,verifierId:"fixture-verifier",runtime:"runsc" as const,sandboxId:"fixture-sandbox",outcome:"pass" as const,exitCode:0,startedAt:now.toISOString(),finishedAt:new Date(now.getTime()+5).toISOString(),stdout:artifact,stderr:artifact,inputManifest:manifest};
    const receipt:TrustedCheckReceiptV1={...body,receiptDigest:receiptDigestV1(body)};
    await assert.rejects(store.submitVerification!(receipt,capabilityHash,"8".repeat(40),now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222"),MissionConflictError);
    await db.query("UPDATE mission_slices SET lease_epoch=lease_epoch+1 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id]);await assert.rejects(store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222"),MissionConflictError);await db.query("UPDATE mission_slices SET lease_epoch=lease_epoch-1 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id]);
    await db.query("UPDATE mission_slices SET candidate_sha=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,"f".repeat(40)]);await assert.rejects(store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222"),MissionConflictError);await db.query("UPDATE mission_slices SET candidate_sha=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,candidateSha]);
    await db.query("UPDATE mission_slices SET lease_plan_digest=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,"0".repeat(64)]);await assert.rejects(store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222"),MissionConflictError);await db.query("UPDATE mission_slices SET lease_plan_digest=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,request.planDigest]);
    await db.query("UPDATE mission_slices SET verification_policy_digest=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,"0".repeat(64)]);await assert.rejects(store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222"),MissionConflictError);await db.query("UPDATE mission_slices SET verification_policy_digest=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,request.policyDigest]);
    await db.query("UPDATE mission_plans SET slices='[]'::jsonb WHERE mission_id=$1",[mission.id]);await assert.rejects(store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222"),MissionConflictError);await db.query("UPDATE mission_plans SET slices=$2::jsonb WHERE mission_id=$1",[mission.id,canonicalJson(record.plan.slices)]);
    const certificate=await store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"22222222-2222-4222-8222-222222222222");assert(certificate);assert.equal(certificate.scope,"local-exact-commit");
    const duplicates=await Promise.all([store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"33333333-3333-4333-8333-333333333333"),store.submitVerification!(receipt,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"44444444-4444-4444-8444-444444444444")]);assert.deepEqual(duplicates,[certificate,certificate]);
    await assert.rejects(store.submitVerification!(receipt,hash("forged-capability"),candidateSha,now.toISOString(),"7".repeat(64),"44444444-4444-4444-8444-444444444444"),MissionConflictError);
    const lateBody={...body,finishedAt:new Date(expires.getTime()+1).toISOString()};const latePass={...lateBody,receiptDigest:receiptDigestV1(lateBody)};
    await assert.rejects(store.submitVerification!(latePass,capabilityHash,candidateSha,now.toISOString(),"7".repeat(64),"55555555-5555-4555-8555-555555555555"));
    assert.deepEqual(await store.getCertificate!(mission.id,slice.id,"check:unit"),certificate);
    assert.equal((await store.getMission(mission.id))?.slices[0]?.status,"awaiting_verification");
    const events=await store.events(mission.id,0);assert.equal(events.filter(e=>e.type==="check.certified").length,1);

    const unknownMission=await store.submit({repository:"owner/other",baseSha,objective:"expiry fixture",acceptance:["expired attempt is unknown"],budgetCents:100});await store.recommendPlan(unknownMission.id,[slice],"owner-session");await store.approvePlan(unknownMission.id);
    const unknownGrant=await store.claim(300,policyDigest);assert(unknownGrant);await store.complete(unknownMission.id,slice.id,unknownGrant.epoch,unknownGrant.leaseToken,unknownGrant.capabilityToken,candidateSha,[]);
    const unknownRecord=await store.getMission(unknownMission.id);assert(unknownRecord?.plan);const unknownNow=new Date(),unknownExpiry=new Date(unknownNow.getTime()+60_000);
    const unknownRequest={...request,attemptId:"77777777-7777-4777-8777-777777777777",missionId:unknownMission.id,repository:"owner/other",requestedAt:unknownNow.toISOString(),expiresAt:unknownExpiry.toISOString(),planDigest:hash(canonicalJson(unknownRecord.plan.slices))};
    const unknownCapHash=hash("unknown-fixture-capability");await store.createVerificationAttempt!({request:unknownRequest,capabilityHash:unknownCapHash,capabilityExpiresAt:new Date(unknownExpiry.getTime()+120_000).toISOString(),leasePolicyDigest:policyDigest,headObservedAt:unknownNow.toISOString(),headObservationDigest:"9".repeat(64)});
    const unknownBody={...body,request:unknownRequest,outcome:"unknown" as const,exitCode:null,startedAt:unknownNow.toISOString(),finishedAt:new Date(unknownExpiry.getTime()+1).toISOString()};const unknownReceipt={...unknownBody,receiptDigest:receiptDigestV1(unknownBody)};
    let restartedRuns=0;const restarted=new TrustedCheckCoordinator(store,{prepareBundle:async()=>{throw new Error("unreachable");},observeHead:async()=>({sha:candidateSha,observedAt:new Date().toISOString(),digest:"9".repeat(64)}),run:async()=>{restartedRuns++;throw new Error("must not retry");},verifyArtifacts:async()=>({})},{imageDigest:"f".repeat(64),verifierId:"fixture-verifier",policyDigest:"8".repeat(64),leasePolicyDigest:policyDigest,policyVersion:"fixture-v1",allowedChecks:["check:unit"],attemptLifetimeMs:60_000});
    assert.equal(await restarted.reconcile(),0);assert.equal(restartedRuns,0);assert.equal(await restarted.expire(new Date(unknownExpiry.getTime()+120_001)),1);
    await assert.rejects(store.submitVerification!(unknownReceipt,unknownCapHash,candidateSha,new Date().toISOString(),"7".repeat(64),"88888888-8888-4888-8888-888888888888"),MissionConflictError);
    assert((await store.events(unknownMission.id,0)).some(e=>e.type==="check.unknown"));
  }finally{await db.close();}
});

test("coordinator keeps capability private, runs fixture runner, and hides a certificate when local head moves",async()=>{
  const db=new PGlite();let currentHead=candidateSha;let savedReceipt:TrustedCheckReceiptV1|undefined,runnerCalls=0;
  try{
    for(const path of ["001_initial.sql","002_missions.sql","003_recovery.sql","004_verification.sql"])await db.exec(await readFile(`db/migrations/${path}`,"utf8"));
    let gate=Promise.resolve();const sql:TransactionalSql={query:async(text,params)=>await db.query(text,params as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>release=resolve);await prior;try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
    const store=new SqlMissionStore(sql);await store.configureCapacity(1,"b".repeat(64),new Date(Date.now()+60_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha,objective:"fixture only",acceptance:["join runner and certificate"],budgetCents:100});await store.recommendPlan(mission.id,[slice],"owner-session");await store.approvePlan(mission.id);
    const grant=await store.claim(300,"c".repeat(64));assert(grant);await store.complete(mission.id,slice.id,grant.epoch,grant.leaseToken,grant.capabilityToken,candidateSha,[]);
    const fixtureRunner={
      prepareBundle:async()=>({digest:"e".repeat(64),manifest:Buffer.from("fixture"),files:new Map<string,Buffer>()}),
      observeHead:async()=>({sha:currentHead,observedAt:new Date().toISOString(),digest:"9".repeat(64)}),
      run:async(request:TrustedCheckRequestV1)=>{runnerCalls++;const startedAt=new Date(),artifact={key:`sha256/${"1".repeat(64)}` as `sha256/${string}`,sha256:"1".repeat(64),bytes:0},manifest={...artifact,key:`sha256/${"2".repeat(64)}` as `sha256/${string}`,sha256:"2".repeat(64)};const unsigned={version:"orloom.trusted-check-receipt.v1" as const,request,verifierId:"fixture-verifier",runtime:"runsc" as const,sandboxId:"fixture-sandbox",outcome:"pass" as const,exitCode:0,startedAt:startedAt.toISOString(),finishedAt:new Date(startedAt.getTime()+1).toISOString(),stdout:artifact,stderr:artifact,inputManifest:manifest};savedReceipt={...unsigned,receiptDigest:receiptDigestV1(unsigned)};return savedReceipt;},
      verifyArtifacts:async(receipt:TrustedCheckReceiptV1)=>{assert.equal(receipt,savedReceipt);return{};},
    };
    const coordinatorNow=new Date();const coordinator=new TrustedCheckCoordinator(store,fixtureRunner,{imageDigest:"f".repeat(64),verifierId:"fixture-verifier",policyDigest:"8".repeat(64),leasePolicyDigest:"c".repeat(64),policyVersion:"fixture-v1",allowedChecks:["check:unit"],attemptLifetimeMs:240_000},()=>coordinatorNow);
    assert.throws(()=>new TrustedCheckCoordinator(store,fixtureRunner,{imageDigest:"f".repeat(64),verifierId:"fixture-verifier",policyDigest:"8".repeat(64),leasePolicyDigest:"c".repeat(64),policyVersion:"fixture-v1",allowedChecks:["check:unit"],attemptLifetimeMs:600_001}),/contract bounds/);
    const concurrent=await Promise.allSettled([coordinator.verifySlice(mission.id,slice.id),coordinator.verifySlice(mission.id,slice.id)]);assert.equal(concurrent.filter(x=>x.status==="fulfilled").length,1);assert.equal(runnerCalls,1);assert(savedReceipt);assert.equal(Date.parse(savedReceipt.request.expiresAt)-Date.parse(savedReceipt.request.requestedAt),240_000,"trusted selected attempt budget is bound to the request expiry");const certificate=await store.getCertificate!(mission.id,slice.id,"check:unit");assert(certificate);
    await assert.rejects(store.submitVerification!(savedReceipt!,hash("forged"),candidateSha,new Date().toISOString(),"9".repeat(64),"66666666-6666-4666-8666-666666666666"),MissionConflictError);
    assert.deepEqual(await coordinator.getCertificate(mission.id,slice.id,"check:unit"),certificate);
    currentHead="7".repeat(40);assert.equal(await coordinator.getCertificate(mission.id,slice.id,"check:unit"),null);
    assert.deepEqual(await store.awaitingVerification!(["check:unit"]),[]);
  }finally{await db.close();}
});
