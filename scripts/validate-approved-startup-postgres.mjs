import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresJobStore } from "../dist/packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "../dist/packages/contracts/src/sql-mission-store.js";
import { MissionGovernor } from "../dist/packages/governor/src/governor.js";
import { canonicalJson } from "../dist/packages/judgment/src/canonical.js";
const databaseUrl=process.env.ORLOOM_STARTUP_TEST_DATABASE_URL;
if(!databaseUrl)throw new Error("Explicit isolated startup-test database required");
const hash=value=>createHash("sha256").update(value).digest("hex");
const policy=hash("startup-fixture-policy"),baseSha="a".repeat(40);
const first=await PostgresJobStore.connect(databaseUrl),second=await PostgresJobStore.connect(databaseUrl);
try{
  const store=new SqlMissionStore(first),other=new SqlMissionStore(second);
  await store.configureCapacity(1,hash("startup-fixture-capacity"),new Date(Date.now()+300000).toISOString());
  const add=async(index)=>{
    const mission=await store.submit({repository:`fixture/repo${index}`,baseSha,objective:`owned task ${index}`,acceptance:["exact target only"],budgetCents:100});
    const slice={id:"slice",objective:"one owned fixture",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100};
    await store.recommendPlan(mission.id,[slice],"owner-authored-fixture");await store.approvePlan(mission.id);
    return {mission,slice,target:{missionId:mission.id,sliceId:slice.id,repository:mission.repository,baseSha,planDigest:hash(canonicalJson([slice])),maxBudgetCents:100}};
  };
  const queued=[];for(let index=0;index<35;index++)queued.push(await add(index));
  const selected=await add("target"),{target}=selected;
  const config={maxLanes:1,capacitySlots:1,leaseSeconds:300,trustedCheckPolicyDigest:policy,trustedCheckPolicy:["check:unit"],executionConfigured:true};
  let schedulingCalls=0;
  const unexpectedScheduler=async()=>{schedulingCalls++;throw new Error("targeted mode must not consult model scheduling");};
  const governor=new MissionGovernor(store,config,undefined,unexpectedScheduler);
  const competitor=new MissionGovernor(other,config,undefined,unexpectedScheduler);
  for(const invalid of [{...target,baseSha:"b".repeat(40)},{...target,repository:"fixture/foreign"},{...target,planDigest:"0".repeat(64)},{...target,maxBudgetCents:99}]){
    assert.equal(await governor.claimApproved(invalid),null);
  }
  assert.equal((await store.getMission(target.missionId)).mission.reservedCents,0);
  const grants=await Promise.all([governor.claimApproved(target),competitor.claimApproved(target)]);
  assert.equal(grants.filter(Boolean).length,1);
  const grant=grants.find(Boolean);assert(grant);assert.equal(grant.mission.id,target.missionId);
  for(const entry of queued){const record=await store.getMission(entry.mission.id);assert.equal(record.mission.reservedCents,0);assert.equal(record.slices[0].status,"ready");}
  assert.equal(schedulingCalls,0);
  await store.requestCancel(target.missionId,"owner-startup-proof","stop before runtime");
  const identity={missionId:target.missionId,sliceId:target.sliceId,leaseEpoch:grant.epoch,controllerRunId:hash("trusted-no-runtime-fixture")};
  assert.equal(await other.settleCancellationBeforeRuntime(identity),"settled");
  const restarted=new SqlMissionStore(second);
  assert.equal(await restarted.settleCancellationBeforeRuntime(identity),"settled");
  const record=await restarted.getMission(target.missionId);assert.equal(record.mission.status,"cancelled");assert.equal(record.mission.reservedCents,100);
  assert.equal((await restarted.events(target.missionId,0)).filter(event=>event.type==="slice.claimed").length,1);
  console.log(JSON.stringify({result:"PASS",database:"actual isolated PostgreSQL",unrelatedReadyMissions:35,unrelatedReservations:0,targetedClaimWinners:1,schedulingCalls,preRuntimeSettlementReplay:"settled",reservedCents:100,liveProvider:false,runsc:false}));
}finally{await first.close();await second.close();}
