import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import type { SliceInput } from "../packages/contracts/src/mission.js";
import { receiptDigestV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const baseSha="a".repeat(40),candidateSha="d".repeat(40),policyDigest="c".repeat(64);
const slice:SliceInput={id:"source",objective:"verify candidate",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100};

test("explicit final reverification preserves UNKNOWN, certifies once, and remains outside automatic retry",async()=>{
  const db=new PGlite();let outcome:"unknown"|"pass"="unknown",runs=0,lastReceipt:TrustedCheckReceiptV1|undefined;
  try{
    for(const file of (await readdir("db/migrations")).filter(x=>x.endsWith(".sql")).sort())await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
    let gate=Promise.resolve();const sql:TransactionalSql={query:async(text,values)=>await db.query(text,values as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>release=resolve);await prior;try{await db.exec("BEGIN");const value=await work({query:async(text,values)=>await db.query(text,values as never) as never});await db.exec("COMMIT");return value;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
    const store=new SqlMissionStore(sql);await store.configureCapacity(1,"b".repeat(64),new Date(Date.now()+120_000).toISOString());
    const mission=await store.submit({repository:"owner/repo",baseSha,objective:"one explicit reverification",acceptance:["retain evidence"],budgetCents:100});await store.recommendPlan(mission.id,[slice],"owner-session");await store.approvePlan(mission.id);
    const grant=await store.claim(300,policyDigest,["check:unit"]);assert(grant);await store.complete(mission.id,slice.id,grant.epoch,grant.leaseToken,grant.capabilityToken,candidateSha,[]);
    const runner={prepareBundle:async()=>({digest:"e".repeat(64),manifest:Buffer.from("fixture"),files:new Map<string,Buffer>()}),observeHead:async()=>({sha:candidateSha,observedAt:new Date().toISOString(),digest:"9".repeat(64)}),run:async(request:TrustedCheckRequestV1)=>{runs++;const now=new Date(),artifact={key:`sha256/${"1".repeat(64)}` as `sha256/${string}`,sha256:"1".repeat(64),bytes:0},manifest={...artifact,key:`sha256/${"2".repeat(64)}` as `sha256/${string}`,sha256:"2".repeat(64)};const body={version:"orloom.trusted-check-receipt.v1" as const,request,verifierId:"fixture-verifier",runtime:"runsc" as const,sandboxId:"fixture-sandbox",outcome,exitCode:outcome==="pass"?0:null,startedAt:now.toISOString(),finishedAt:new Date(now.getTime()+1).toISOString(),stdout:artifact,stderr:artifact,inputManifest:manifest};lastReceipt={...body,receiptDigest:receiptDigestV1(body)};return lastReceipt;},verifyArtifacts:async()=>({stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),manifest:Buffer.from("fixture")})};
    const coordinator=new TrustedCheckCoordinator(store,runner,{imageDigest:"f".repeat(64),verifierId:"fixture-verifier",policyDigest,leasePolicyDigest:policyDigest,policyVersion:"fixture-v1",allowedChecks:["check:unit"],attemptLifetimeMs:60_000});
    await coordinator.verifySlice(mission.id,slice.id);assert(lastReceipt);const original=lastReceipt,priorId=original.request.attemptId,priorDigest=original.receiptDigest;
    const unchanged=await store.getTrustedAttempt!(priorId);assert.equal(unchanged?.outcome,"unknown");assert.deepEqual(unchanged?.receipt,original);
    const makeBinding=async()=>{const record=await store.getMission(mission.id);assert(record?.plan);const now=new Date(),request:TrustedCheckRequestV1={version:"orloom.trusted-check-request.v1",attemptId:"22222222-2222-4222-8222-222222222222",missionId:mission.id,sliceId:slice.id,leaseEpoch:grant.epoch,repository:"owner/repo",candidateSha,expectedLocalHeadSha:candidateSha,planDigest:hash(JSON.stringify(record.plan!.slices).replaceAll("\\u000a","")),checkId:"check:unit",policyVersion:"fixture-v1",policyDigest,verifierImageDigest:"f".repeat(64),inputBundleDigest:"e".repeat(64),requestedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60_000).toISOString()};return{request,capabilityHash:hash("retry-capability"),capabilityExpiresAt:new Date(now.getTime()+120_000).toISOString(),leasePolicyDigest:policyDigest,headObservedAt:now.toISOString(),headObservationDigest:"9".repeat(64)};};
    // Use the persisted request's plan digest exactly, matching the accepted plan hash.
    const retryBinding=await makeBinding();retryBinding.request.planDigest=original.request.planDigest;
    const assertBlocked=async()=>assert.rejects(store.createFinalReverificationAttempt!(retryBinding,priorId,priorDigest));
    await db.query("UPDATE verification_attempts SET outcome=NULL,terminal_at=NULL WHERE attempt_id=$1",[priorId]);await assertBlocked();await db.query("UPDATE verification_attempts SET outcome='unknown',terminal_at=now() WHERE attempt_id=$1",[priorId]);
    await db.query("UPDATE mission_slices SET status='blocked' WHERE mission_id=$1 AND id=$2",[mission.id,slice.id]);await assertBlocked();await db.query("UPDATE mission_slices SET status='awaiting_verification' WHERE mission_id=$1 AND id=$2",[mission.id,slice.id]);
    await db.query("UPDATE verification_attempts SET outcome='pass' WHERE attempt_id=$1",[priorId]);await assertBlocked();await db.query("UPDATE verification_attempts SET outcome='unknown' WHERE attempt_id=$1",[priorId]);
    await db.query("UPDATE verification_attempts SET outcome='fail' WHERE attempt_id=$1",[priorId]);await assertBlocked();await db.query("UPDATE verification_attempts SET outcome='unknown' WHERE attempt_id=$1",[priorId]);
    await db.query("UPDATE mission_slices SET candidate_sha=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,"7".repeat(40)]);await assertBlocked();await db.query("UPDATE mission_slices SET candidate_sha=$3 WHERE mission_id=$1 AND id=$2",[mission.id,slice.id,candidateSha]);
    await db.query("INSERT INTO check_certificates(certificate_id,attempt_id,mission_id,slice_id,check_id,certificate,receipt,head_observed_at,head_observation_digest) VALUES($1,$2,$3,$4,$5,'{}','{}',now(),$6)",["33333333-3333-4333-8333-333333333333",priorId,mission.id,slice.id,"check:unit","9".repeat(64)]);await assertBlocked();await db.query("DELETE FROM check_certificates WHERE mission_id=$1",[mission.id]);
    // A bad digest or a mismatched prior id is rejected without consuming ordinal one.
    await assert.rejects(store.createFinalReverificationAttempt!(retryBinding,priorId,"0".repeat(64)));
    await db.query("UPDATE verification_attempts SET receipt=jsonb_set(receipt,'{request}','{}'::jsonb) WHERE attempt_id=$1",[priorId]);await assertBlocked();await db.query("UPDATE verification_attempts SET receipt=$2::jsonb WHERE attempt_id=$1",[priorId,JSON.stringify(original)]);
    await db.query("UPDATE verification_attempts SET terminal_at=NULL WHERE attempt_id=$1",[priorId]);await assertBlocked();await db.query("UPDATE verification_attempts SET terminal_at=now() WHERE attempt_id=$1",[priorId]);
    await db.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE attempt_id=$1",[priorId,"0".repeat(64)]);await assertBlocked();await db.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE attempt_id=$1",[priorId,policyDigest]);
    const oldBundle=retryBinding.request.inputBundleDigest;retryBinding.request.inputBundleDigest="5".repeat(64);await assertBlocked();retryBinding.request.inputBundleDigest=oldBundle;
    const changedLease={...retryBinding,leasePolicyDigest:"0".repeat(64)};await assert.rejects(store.createFinalReverificationAttempt!(changedLease,priorId,priorDigest));
    outcome="pass";const retryCalls=await Promise.allSettled([coordinator.verifyUnknownFinal(mission.id,slice.id,"check:unit",priorId,priorDigest),coordinator.verifyUnknownFinal(mission.id,slice.id,"check:unit",priorId,priorDigest)]);assert.equal(retryCalls.filter(x=>x.status==="fulfilled").length,1);assert.equal(runs,2);assert.equal(lastReceipt?.outcome,"pass");
    const retryId=lastReceipt!.request.attemptId;assert.notEqual(retryId,priorId);const retry=await store.getTrustedAttempt!(retryId);assert.equal(retry?.outcome,"pass");assert.equal(((await db.query("SELECT final_retry_ordinal FROM verification_attempts WHERE attempt_id=$1",[retryId])).rows[0] as Record<string,unknown>)?.["final_retry_ordinal"],1);
    assert.deepEqual((await store.getTrustedAttempt!(priorId))?.receipt,original);assert.equal((await store.getCertificate!(mission.id,slice.id,"check:unit"))?.attemptId,retryId);
    await assert.rejects(store.createVerificationAttempt!({...retryBinding,request:{...retryBinding.request,attemptId:"44444444-4444-4444-8444-444444444444"}}));
    await assert.rejects(store.createFinalReverificationAttempt!(retryBinding,priorId,priorDigest));
    const concurrent=await Promise.allSettled([store.createFinalReverificationAttempt!(retryBinding,priorId,priorDigest),store.createFinalReverificationAttempt!(retryBinding,priorId,priorDigest)]);assert.equal(concurrent.filter(x=>x.status==="fulfilled").length,0);
    assert.equal(await coordinator.reconcile(),0);assert.equal(runs,2,"automatic reconciliation does not redispatch the terminal retry");
    await db.exec(await readFile("db/migrations/005_learning.sql","utf8"));
    const idx=await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='verification_attempts_final_unique'");assert.match(String((idx.rows[0] as Record<string,unknown>)?.["indexdef"]),/final_retry_ordinal/);
  }finally{await db.close();}
});





