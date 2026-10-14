import { after, test } from "node:test";
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
const migrationFiles=["001_initial.sql","002_missions.sql","003_recovery.sql","004_verification.sql","005_learning.sql","006_integration.sql","007_delivery.sql","008_delivery_upload.sql"];
const resetTables=["jobs","missions","mission_plans","mission_slices","mission_events","mission_governor_lock","capacity_slots","mission_recovery_state","mission_recovery_progress","operational_lessons","operational_lesson_events","verification_attempts","check_certificates","verification_dispatch_failures","operational_lesson_challenges","mission_integration_intents","mission_delivery_intents","mission_delivery_effects"] as const;
const resetTableSet=new Set<string>(resetTables);
const resetSql=`TRUNCATE ${resetTables.join(", ")} RESTART IDENTITY CASCADE`;
let sharedDb:PGlite|undefined;
let fixtureQueue=Promise.resolve();
async function assertFixtureSchema(db:PGlite){
  const inventory=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'") as {rows:{tablename:string}[]};
  assert.deepEqual(inventory.rows.map(row=>row.tablename).filter(name=>!resetTableSet.has(name)).sort(),[],"every migrated public table must be included in fixture reset inventory");
  const lock=await db.query("SELECT lock_id FROM mission_governor_lock ORDER BY lock_id") as {rows:{lock_id:number}[]};
  assert.deepEqual(lock.rows,[{lock_id:1}],"migrated governor lock seed is present exactly once");
}
async function acquireFixture(){
  let release!:()=>void;const previous=fixtureQueue;fixtureQueue=new Promise<void>(resolve=>release=resolve);await previous;
  try{
    if(!sharedDb){sharedDb=new PGlite();for(const file of migrationFiles)await sharedDb.exec(await readFile(`db/migrations/${file}`,"utf8"));await assertFixtureSchema(sharedDb);}
    else{await sharedDb.exec(resetSql);await sharedDb.query("INSERT INTO mission_governor_lock(lock_id) VALUES(1) ON CONFLICT DO NOTHING");await assertFixtureSchema(sharedDb);}
    return{db:sharedDb,release};
  }catch(error){release();throw error;}
}
after(async()=>{await fixtureQueue;if(sharedDb)await sharedDb.close();});
const command:DeliveryCommandV1={version:"orloom.delivery-command.v1",missionId:"11111111-1111-4111-8111-111111111111",sliceId:"delivery",leaseEpoch:1,integratedSha:sha,treeSha:tree,reviewArtifactId:"review-001",reviewArtifactDigest:"",idempotencyKey:"delivery-idempotency-00001"};
const policy:DeliveryPolicy={repository:"acme/orloom",appId:11,installationId:9,baseRef:"main",baseSha:base,protectedRefs:["main"],checkIds:["node-repo-suite-v1"],policyVersion:"policy-v1",policyDigest:digest,imageDigest:"e".repeat(64),checkName:"Orloom certified suite"};

type Check=Awaited<ReturnType<GitHubInstallationClient["createDeliveryCheck"]>>;
type PullRequest=Awaited<ReturnType<GitHubInstallationClient["createDraftPullRequest"]>>;

async function setup(mode:{configuredAppId?:number;checkPost?:"normal"|"throw_after"|"throw_absent";prPost?:"normal"|"throw_after";uploadPost?:"normal"|"throw_after"|"throw_absent";branchRead?:"wrong_sha"|"wrong_tree"|"error";baseRead?:"wrong"|"error";appId?:number;checkGetId?:number;prGetNumber?:number;draft?:boolean;state?:string;merged?:boolean;duplicates?:boolean;noUploadCredential?:boolean}={}){
  const fixture=await acquireFixture(),db=fixture.db;
  try{
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
  await sql.query("UPDATE mission_slices SET evidence_refs=$2::jsonb WHERE mission_id=$1 AND id=$3",[mission.id,canonicalJson([`integration:${sha}`,`review:${command.reviewArtifactDigest}`]),command.sliceId]);
  const artifacts=new Map<string,Buffer>([[ref(out).key,out],[ref(err).key,err],[ref(manifest).key,manifest]]);
  const store=Object.create(sqlStore) as MissionStore;
  store.getIntegratedCertificate=async(_m,_s,_e,id)=>id===certificate.checkId?certificate:null;
  store.getTrustedAttempt=async id=>id===request.attemptId?{purpose:"final",request,outcome:"pass",receipt,targetCheckId:null,strategyId:null,recoveryOrdinal:null,headObservedAt:now,headObservationDigest:digest,leasePolicyDigest:digest}:null;
  let check:Check|undefined,pr:PullRequest|undefined,remoteUploaded=false,uploadPosts=0,checkPosts=0,prPosts=0,checkReads=0,prReads=0;
  const github:GitHubInstallationClient={
    appId:mode.configuredAppId??policy.appId,
    withContentsWriteToken:async<T>(_install:number,_repo:string,action:(token:string)=>Promise<T>):Promise<T>=>action("fixture-token"),
    createInstallationToken:async()=>"fixture",createCheckRun:async()=>{},
    inspectBranch:async(_install,_repo,ref)=>{if(ref==="main"){if(mode.baseRead==="error")throw new Error("unavailable");return{sha:mode.baseRead==="wrong"?"f".repeat(40):base,treeSha:tree};}if(mode.branchRead==="error")throw new Error("unavailable");if(!remoteUploaded)return null;return{sha:mode.branchRead==="wrong_sha"?"f".repeat(40):sha,treeSha:mode.branchRead==="wrong_tree"?"f".repeat(40):tree};},
    listCheckRuns:async(_install,_repo,headSha,name,externalId)=>{
      if(mode.duplicates){const existing=check??{id:81,headSha,name,externalId,conclusion:"success",appId:policy.appId};return[existing,{...existing,id:existing.id+1}];}
      return check?[check]:[];
    },
    getCheckRun:async(_install,_repo,id)=>{checkReads++;if(!check||check.id!==id)throw new Error("Check unavailable");return{...check,id:mode.checkGetId??check.id,appId:mode.appId??check.appId};},
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
    getPullRequest:async(_install,_repo,number)=>{prReads++;if(!pr||pr.number!==number)throw new Error("PR unavailable");return{...pr,number:mode.prGetNumber??pr.number};}
  };
  if(mode.noUploadCredential)delete(github as unknown as {withContentsWriteToken?:GitHubInstallationClient["withContentsWriteToken"]}).withContentsWriteToken;
  const integrator={repositoryIdentity:policy.repository,readRef:async()=>sha,inspect:async()=>({candidateSha:sha,treeSha:tree,expectedIntegrationSha:base}),uploadRef:async()=>{uploadPosts++;if(mode.uploadPost==="throw_absent")throw new Error("unavailable");remoteUploaded=true;if(mode.uploadPost==="throw_after")throw new Error("ack lost");}};
  const authority={integrator,reviews:{read:async(id:string)=>id===command.reviewArtifactId?reviewBytes:null},artifacts:{put:async()=>({key:"",sha256:""}),get:async(key:string)=>{const value=artifacts.get(key);if(!value)throw new Error("artifact unavailable");return value;}},github} as never;
  return{db,close:async()=>fixture.release(),store,sqlStore,authority,counts:()=>({uploadPosts,checkPosts,prPosts,checkReads,prReads}),missionId:mission.id,planDigest:planDigest(plan)};
  }catch(error){fixture.release();throw error;}
}
function planDigest(plan:{slices:SliceInput[]}){return hash(canonicalJson(plan.slices));}

async function deliver(fixture:Awaited<ReturnType<typeof setup>>){return deliverIntegratedCommit(command,policy,fixture.authority,fixture.store);}

test("serialized shared PGlite fixtures reset mutations after a failed test body",async()=>{
  const failed=await setup();
  const failedMissionId=failed.missionId;
  try{
    await failed.db.query("UPDATE missions SET objective='mutated before fixture failure' WHERE id=$1",[failedMissionId]);
    await failed.db.query("INSERT INTO mission_delivery_intents(mission_id,slice_id,lease_epoch,request,state) VALUES($1,'failed-fixture',1,'{}'::jsonb,'unknown')",[failedMissionId]);
    await failed.db.query("INSERT INTO mission_delivery_effects(mission_id,slice_id,lease_epoch,effect,state) VALUES($1,'failed-fixture',1,'upload','claimed')",[failedMissionId]);
    await assert.rejects(async()=>{throw new Error("injected fixture failure")},/injected fixture failure/);
  }finally{await failed.close();}
  const next=await setup();
  try{
    const rows=await next.db.query("SELECT id,objective FROM missions ORDER BY id");
    assert.equal(rows.rows.length,1,"only the new fixture mission remains");
    assert.equal((rows.rows[0] as {id:string;objective:string}).id,next.missionId);
    assert.equal((rows.rows[0] as {objective:string}).objective,"deliver reviewed commit","the next fixture starts from clean migrated database state");
    const oldMission=await next.db.query("SELECT id FROM missions WHERE id=$1",[failedMissionId]);
    assert.equal(oldMission.rows.length,0,"the previous fixture mission is absent");
    const effects=await next.db.query("SELECT mission_id FROM mission_delivery_effects");
    assert.equal(effects.rows.length,0,"effects from a prior failed fixture cannot leak");
    const lock=await next.db.query("SELECT lock_id FROM mission_governor_lock ORDER BY lock_id") as {rows:{lock_id:number}[]};
    assert.deepEqual(lock.rows,[{lock_id:1}],"reset preserves the migration-seeded governor lock row");
  }finally{await next.close();}
});

test("positive delivery persists one exact Check GET readback and an open unmerged draft PR",async()=>{
  const f=await setup();try{
    const result=await deliver(f);assert.equal(result.state,"pr_created");assert.equal(result.appId,policy.appId);assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);assert.equal(f.counts().checkReads,1);assert.equal(f.counts().prReads,1);
    const replay=await deliver(f);assert.equal(replay.state,"pr_created");assert.deepEqual(f.counts(),{uploadPosts:1,checkPosts:1,prPosts:1,checkReads:2,prReads:2});
  }finally{await f.close();}
});

test("delivery rejects duplicate, mismatched, and unknown C4 metadata before any external effect",async()=>{
  const f=await setup();
  try{
    const setRefs=async(refs:string[])=>f.db.query("UPDATE mission_slices SET evidence_refs=$2::jsonb WHERE mission_id=$1 AND id=$3",[f.missionId,canonicalJson(refs),command.sliceId]);
    const rejectRefs=async(refs:string[])=>{await setRefs(refs);await assert.rejects(deliver(f),/C4 attribution|content-addressed|artifact unavailable/);assert.deepEqual(f.counts(),{uploadPosts:0,checkPosts:0,prPosts:0,checkReads:0,prReads:0});};
    const integrationRef=`integration:${command.integratedSha}`,reviewRef=`review:${command.reviewArtifactDigest}`;
    await rejectRefs([integrationRef,integrationRef,reviewRef]);
    await rejectRefs([integrationRef,reviewRef,reviewRef]);
    await rejectRefs([`integration:${"f".repeat(40)}`,reviewRef]);
    await rejectRefs([integrationRef,`review:${"f".repeat(64)}`]);
    await rejectRefs([integrationRef,reviewRef,"worker:asserted-verified"]);
    await rejectRefs([integrationRef,reviewRef,`sha256/${"a".repeat(64)}`]);
    await setRefs([integrationRef,reviewRef]);
    assert.equal((await deliver(f)).state,"pr_created");
  }finally{await f.close();}
});

test("Check-only interruption is reconciled by exact GET then proceeds to one PR without retrying Check POST",async()=>{
  const f=await setup({checkPost:"throw_after"});try{
    await assert.rejects(deliver(f),/Check write or separate Check readback/);
    const recovered=await deliver(f);assert.equal(recovered.state,"pr_created");assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);assert(f.counts().checkReads>=1);
  }finally{await f.close();}
});

test("interrupted PR create is reconciled after durable Check and PR claims without retry",async()=>{
  const f=await setup({prPost:"throw_after"});try{
    await assert.rejects(deliver(f),/Draft PR write or separate PR readback/);
    const recovered=await deliver(f);assert.equal(recovered.state,"pr_created");assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);
  }finally{await f.close();}
});

test("concurrent delivery calls cannot both claim either create effect",async()=>{
  const f=await setup();try{
    const results=await Promise.allSettled([deliver(f),deliver(f)]);
    assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);assert(results.some(x=>x.status==="fulfilled"));
  }finally{await f.close();}
});

test("upload interruption is reconciled after the exact remote ref appears and is never pushed twice",async()=>{
  const f=await setup({uploadPost:"throw_after"});try{
    await assert.rejects(deliver(f),/Remote upload or separate SHA\/tree\/base readback is unresolved/);
    assert.deepEqual(f.counts(),{uploadPosts:1,checkPosts:0,prPosts:0,checkReads:0,prReads:0});
    const request:DeliveryRequestV1={version:"orloom.delivery-request.v1",missionId:command.missionId,sliceId:command.sliceId,leaseEpoch:command.leaseEpoch,integratedSha:command.integratedSha,treeSha:command.treeSha,repository:policy.repository.toLowerCase(),appId:policy.appId,installationId:policy.installationId,branch:`orloom/delivery/${command.missionId}/${hash(command.sliceId).slice(0,12)}`,baseRef:policy.baseRef,baseSha:policy.baseSha,checkIds:policy.checkIds,reviewArtifactId:command.reviewArtifactId,reviewArtifactDigest:command.reviewArtifactDigest,idempotencyKey:command.idempotencyKey};
    await assert.rejects(f.store.claimDeliveryEffect!(request,"check"),/Remote upload must be observed/);
    const result=await deliver(f);assert.equal(result.state,"pr_created");
    assert.equal(f.counts().uploadPosts,1);assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,1);
  }finally{await f.close();}
});

test("a prior claimed upload with an absent branch, wrong branch or moved base stays UNKNOWN without Checks",async t=>{
  for(const mode of [{uploadPost:"throw_absent" as const},{branchRead:"wrong_sha" as const},{branchRead:"wrong_tree" as const},{baseRead:"wrong" as const},{baseRead:"error" as const}])await t.test(JSON.stringify(mode),async()=>{
    const f=await setup(mode);try{
      await assert.rejects(deliver(f));
      await assert.rejects(deliver(f));
      assert.equal(f.counts().uploadPosts,mode.uploadPost||mode.branchRead?1:0);assert.equal(f.counts().checkPosts,0);assert.equal(f.counts().prPosts,0);
    }finally{await f.close();}
  });
});

test("unresolved absent effect remains UNKNOWN and is never blindly retried",async()=>{
  const f=await setup({checkPost:"throw_absent"});try{
    await assert.rejects(deliver(f),/Check write or separate Check readback/);
    await assert.rejects(deliver(f),/prior Check write may have occurred/);
    assert.equal(f.counts().checkPosts,1);assert.equal(f.counts().prPosts,0);
  }finally{await f.close();}
});

test("missing scoped upload credential capability closes delivery before creating a claim",async()=>{
  const f=await setup({noUploadCredential:true});try{
    await assert.rejects(deliver(f),/closed without controller-owned upload/);
    const q=await f.db.query("SELECT effect FROM mission_delivery_effects WHERE mission_id=$1",[f.missionId]);assert.equal(q.rows.length,0);
  }finally{await f.close();}
});

test("wrong App identity, mismatched GET IDs, duplicate Checks, and closed or merged PRs remain non-success",async t=>{
  for(const scenario of [{name:"wrong App in Check readback",mode:{appId:999}},{name:"Check GET returns a different id",mode:{checkGetId:82}},{name:"PR GET returns a different number",mode:{prGetNumber:92}},{name:"configured App policy mismatch",mode:{configuredAppId:99}},{name:"ambiguous Checks",mode:{duplicates:true}},{name:"closed draft",mode:{state:"closed"}},{name:"merged draft",mode:{merged:true}},{name:"non-draft PR",mode:{draft:false}}]){
    await t.test(scenario.name,async()=>{const f=await setup(scenario.mode);try{await assert.rejects(deliver(f));const state=await f.db.query("SELECT state FROM mission_delivery_intents WHERE mission_id=$1",[f.missionId]);assert.notEqual((state.rows[0] as {state:string}|undefined)?.state,"pr_created");}finally{await f.close();}});
  }
});
