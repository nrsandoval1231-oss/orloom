import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import type { DeliveryRequestV1, MissionStore, SliceInput } from "../packages/contracts/src/mission.js";
import { receiptDigestV1, type CheckCertificateV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { deliverIntegratedCommit, type DeliveryCommandV1, type DeliveryPolicy } from "../packages/integration/src/delivery.js";
import type { GitHubInstallationClient } from "../packages/adapters/src/providers.js";

const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const sha="a".repeat(40),tree="b".repeat(40),base="c".repeat(40),digest="d".repeat(64);
const command:DeliveryCommandV1={version:"orloom.delivery-command.v1",missionId:"11111111-1111-4111-8111-111111111111",sliceId:"delivery",leaseEpoch:1,integratedSha:sha,treeSha:tree,reviewArtifactId:"review-001",reviewArtifactDigest:"",idempotencyKey:"delivery-idempotency-00001"};
const policy:DeliveryPolicy={repository:"acme/orloom",appId:11,installationId:9,baseRef:"main",baseSha:base,protectedRefs:["main"],checkIds:["node-repo-suite-v1"],policyVersion:"policy-v1",policyDigest:digest,imageDigest:"e".repeat(64),checkName:"Orloom certified suite"};

type Check=Awaited<ReturnType<GitHubInstallationClient["createDeliveryCheck"]>>;
type PullRequest=Awaited<ReturnType<GitHubInstallationClient["createDraftPullRequest"]>>;

async function setup(mode:{configuredAppId?:number;checkPost?:"normal"|"throw_after"|"throw_absent";prPost?:"normal"|"throw_after";appId?:number;draft?:boolean;state?:string;merged?:boolean;duplicates?:boolean}={}){
  const db=new PGlite();
  for(const file of ["001_initial.sql","002_missions.sql","003_recovery.sql","004_verification.sql","005_learning.sql","006_integration.sql","007_delivery.sql"])await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
  let lock=Promise.resolve();
  const sql:TransactionalSql={
    query:async(text,params)=>await db.query(text,params as never) as never,
    transaction:async work=>{
      let release!:()=>void;const previous=lock;lock=new Promise<void>(resolve=>release=resolve);await previous;
      try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}
      catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}
    }
  };
  const sqlStore=new SqlMissionStore(sql);
  const mission=await sqlStore.submit({repository:policy.repository,baseSha:base,objective:"deliver reviewed commit",acceptance:["read back exact PR"],budgetCents:100});
  const slices:SliceInput[]=[{id:command.sliceId,objective:"deliver",dependencies:[],owner:"builder",scopes:["src"],checks:policy.checkIds,budgetCents:100}];
  const plan=await sqlStore.recommendPlan(mission.id,slices,"owner-session");await sqlStore.approvePlan(mission.id);
  const now=new Date().toISOString();
  const request:TrustedCheckRequestV1={version:"orloom.trusted-check-request.v1",attemptId:"22222222-2222-4222-8222-222222222222",missionId:mission.id,sliceId:command.sliceId,leaseEpoch:1,repository:policy.repository,candidateSha:sha,expectedLocalHeadSha:sha,planDigest:digest,checkId:policy.checkIds[0]!,policyVersion:policy.policyVersion,policyDigest:policy.policyDigest,verifierImageDigest:policy.imageDigest,inputBundleDigest:digest,requestedAt:now,expiresAt:new Date(Date.now()+60000).toISOString()};
  const out=Buffer.from("out"),err=Buffer.from("err"),manifest=Buffer.from("manifest");
  const ref=(bytes:Buffer)=>({key:`sha256/${hash(bytes)}` as `sha256/${string}`,sha256:hash(bytes),bytes:bytes.length});
  const receiptBody={version:"orloom.trusted-check-receipt.v1" as const,request,verifierId:"fixture",runtime:"runsc" as const,sandboxId:"sandbox",outcome:"pass" as const,exitCode:0,startedAt:now,finishedAt:now,stdout:ref(out),stderr:ref(err),inputManifest:ref(manifest)};
  const receipt:TrustedCheckReceiptV1={...receiptBody,receiptDigest:receiptDigestV1(receiptBody)};
  const certificate:CheckCertificateV1={version:"orloom.check-certificate.v1",certificateId:"cert-001",attemptId:request.attemptId,missionId:mission.id,sliceId:command.sliceId,leaseEpoch:1,repository:policy.repository,candidateSha:sha,localHeadSha:sha,checkId:request.checkId,planDigest:digest,policyVersion:policy.policyVersion,policyDigest:policy.policyDigest,receiptDigest:receipt.receiptDigest,certifiedAt:now,scope:"local-exact-commit"};
  const reviewBytes=Buffer.from(canonicalJson({version:"orloom.independent-review.v1",verdict:"PASS",candidateSha:sha,treeSha:tree,builder:"builder",reviewer:"independent-reviewer",scopes:["src"]}));
  Object.assign(command,{missionId:mission.id,reviewArtifactDigest:hash(reviewBytes)});
  const integrationRequest={version:"orloom.integration-request.v1",missionId:mission.id,sliceId:command.sliceId,expectedIntegrationSha:base,candidateSha:sha,leaseEpoch:1,requiredCheckIds:policy.checkIds,reviewArtifactId:command.reviewArtifactId,reviewArtifactDigest:command.reviewArtifactDigest};
  await sql.query("UPDATE mission_slices SET status='verified',lease_epoch=1,candidate_sha=$3 WHERE mission_id=$1 AND id=$2",[mission.id,command.sliceId,sha]);
  await sql.query("UPDATE missions SET status='verified' WHERE id=$1",[mission.id]);
  await sql.query("INSERT INTO mission_integration_intents(mission_id,slice_id,lease_epoch,request,plan_digest,policy_digest,tree_sha,certificate_ids,certificate_digests,review_digest,state,observed_integration_sha) VALUES($1,$2,1,$3::jsonb,$4,$5,$6,$7::jsonb,$8::jsonb,$9,'integrated',$10)",[mission.id,command.sliceId,canonicalJson(integrationRequest),planDigest(plan),policy.policyDigest,tree,canonicalJson([certificate.certificateId]),canonicalJson([hash(canonicalJson(certificate))]),command.reviewArtifactDigest,sha]);
  const artifacts=new Map<string,Buffer>([[ref(out).key,out],[ref(err).key,err],[ref(manifest).key,manifest]]);
  const store=Object.create(sqlStore) as MissionStore;
  store.getIntegratedCertificate=async(_m,_s,_e,id)=>id===certificate.checkId?certificate:null;
  store.getTrustedAttempt=async id=>id===request.attemptId?{purpose:"final",request,outcome:"pass",receipt,targetCheckId:null,strategyId:null,recoveryOrdinal:null,headObservedAt:now,headObservationDigest:digest}:null;
  let check:Check|undefined,pr:PullRequest|undefined,checkPosts=0,prPosts=0,checkReads=0,prReads=0;
  const github:GitHubInstallationClient={
    appId:mode.configuredAppId??policy.appId,
    createInstallationToken:async()=>"fixture",createCheckRun:async()=>{},
    inspectBranch:async(_install,_repo,ref)=>ref==="main"?{sha:base,treeSha:tree}:{sha,treeSha:tree},
    listCheckRuns:async(_install,_repo,headSha,name,externalId)=>{
      if(mode.duplicates){const existing=check??{id:81,headSha,name,externalId,conclusion:"success",appId:policy.appId};return[existing,{...existing,id:existing.id+1}];}
      return check?[check]:[];
    },
    getCheckRun:async(_install,_repo,id)=>{checkReads++;if(!check||check.id!==id)throw new Error("Check unavailable");return{...check,appId:mode.appId??check.appId};},
    createDeliveryCheck:async(_install,_repo,headSha,name,externalId)=>{
      const claim=await db.query("SELECT state FROM mission_delivery_effects WHERE mission_id=$1 AND slice_id=$2 AND lease_epoch=1 AND effect='check'",[mission.id,command.sliceId]);assert.equal((claim.rows[0] as {state:string}|undefined)?.state,"claimed","durable Check claim precedes POST");
      checkPosts++;
      if(mode.checkPost==="throw_absent")throw new Error("timeout before effect");
      check={id:81,headSha,name,externalId,conclusion:"success",appId:policy.appId};
      if(mode.checkPost==="throw_after")throw new Error("connection lost after Check create");
      return check;
    },
    listPullRequests:async()=>pr?[pr]:[],
    createDraftPullRequest:async(_install,_repo,headRef,baseRef)=>{
      const claim=await db.query("SELECT state FROM mission_delivery_effects WHERE mission_id=$1 AND slice_id=$2 AND lease_epoch=1 AND effect='pull_request'",[mission.id,command.sliceId]);assert.equal((claim.rows[0] as {state:string}|undefined)?.state,"claimed","durable PR claim precedes POST");
      prPosts++;
      pr={number:91,draft:mode.draft??true,state:mode.state??"open",merged:mode.merged??false,headRepository:policy.repository,headRef,headSha:sha,baseRepository:policy.repository,baseRef,baseSha:base};
      if(mode.prPost==="throw_after")throw new Error("connection lost after PR create");
      return pr;
    },
    getPullRequest:async(_install,_repo,number)=>{prReads++;if(!pr||pr.number!==number)throw new Error("PR unavailable");return pr;}
  };
  const integrator={repositoryIdentity:policy.repository,readRef:async()=>sha,inspect:async()=>({candidateSha:sha,treeSha:tree,expectedIntegrationSha:base})};
  const authority={integrator,reviews:{read:async(id:string)=>id===command.reviewArtifactId?reviewBytes:null},artifacts:{put:async()=>({key:"",sha256:""}),get:async(key:string)=>{const value=artifacts.get(key);if(!value)throw new Error("artifact unavailable");return value;}},github} as never;
  return{db,store,sqlStore,authority,counts:()=>({checkPosts,prPosts,checkReads,prReads}),missionId:mission.id,planDigest:planDigest(plan)};
}
function planDigest(plan:{slices:SliceInput[]}){return hash(canonicalJson(plan.slices));}

async function deliver(fixture:Awaited<ReturnType<typeof setup>>){return deliverIntegratedCommit(command,policy,fixture.authority,fixture.store);}

test("positive delivery persists one exact Check GET readback and an open unmerged draft PR",async()=>{
  const f=await setup();try{
    const result=await deliver(f);assert.equal(result.state,"pr_created");assert.equal(result.appId,policy.appId);assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);assert.equal(f.counts().checkReads,1);assert.equal(f.counts().prReads,1);
    const replay=await deliver(f);assert.equal(replay.state,"pr_created");assert.deepEqual(f.counts(),{checkPosts:1,prPosts:1,checkReads:2,prReads:2});
  }finally{await f.db.close();}
});

test("Check-only interruption is reconciled by exact GET then proceeds to one PR without retrying Check POST",async()=>{
  const f=await setup({checkPost:"throw_after"});try{
    await assert.rejects(deliver(f),/Check write or separate Check readback/);
    const recovered=await deliver(f);assert.equal(recovered.state,"pr_created");assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);assert(f.counts().checkReads>=1);
  }finally{await f.db.close();}
});

test("interrupted PR create is reconciled after durable Check and PR claims without retry",async()=>{
  const f=await setup({prPost:"throw_after"});try{
    await assert.rejects(deliver(f),/Draft PR write or separate PR readback/);
    const recovered=await deliver(f);assert.equal(recovered.state,"pr_created");assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);
  }finally{await f.db.close();}
});

test("concurrent delivery calls cannot both claim either create effect",async()=>{
  const f=await setup();try{
    const results=await Promise.allSettled([deliver(f),deliver(f)]);
    assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);assert(results.some(x=>x.status==="fulfilled"));
  }finally{await f.db.close();}
});

test("unresolved absent effect remains UNKNOWN and is never blindly retried",async()=>{
  const f=await setup({checkPost:"throw_absent"});try{
    await assert.rejects(deliver(f),/Check write or separate Check readback/);
    await assert.rejects(deliver(f),/prior Check write may have occurred/);
    assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,0);
  }finally{await f.db.close();}
});

test("wrong App identity, duplicate Checks, and closed or merged PRs remain non-success",async t=>{
  for(const scenario of [{name:"wrong App in Check readback",mode:{appId:999}},{name:"configured App policy mismatch",mode:{configuredAppId:99}},{name:"ambiguous Checks",mode:{duplicates:true}},{name:"closed draft",mode:{state:"closed"}},{name:"merged draft",mode:{merged:true}},{name:"non-draft PR",mode:{draft:false}}]){
    await t.test(scenario.name,async()=>{const f=await setup(scenario.mode);try{await assert.rejects(deliver(f));const state=await f.db.query("SELECT state FROM mission_delivery_intents WHERE mission_id=$1",[f.missionId]);assert.notEqual((state.rows[0] as {state:string}|undefined)?.state,"pr_created");}finally{await f.db.close();}});
  }
});