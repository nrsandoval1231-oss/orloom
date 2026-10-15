import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresJobStore } from "../dist/packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "../dist/packages/contracts/src/sql-mission-store.js";
import { controllerRunIdFor } from "../dist/apps/worker/src/docker-runtime.js";

// Isolated local test database only. This proof never loads provider credentials.
const databaseUrl = process.env.ORLOOM_COMPOSITION_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Explicit isolated test database URL required");
const first = await PostgresJobStore.connect(databaseUrl);
const second = await PostgresJobStore.connect(databaseUrl);
const digest = value => createHash("sha256").update(value).digest("hex");
try {
  const store = new SqlMissionStore(first), other = new SqlMissionStore(second);
  await store.configureCapacity(1, digest("local PostgreSQL fixture"), new Date(Date.now()+300000).toISOString());
  const mission = await store.submit({repository:"fixture/owned",baseSha:"a".repeat(40),objective:"trusted cancellation settlement",acceptance:["capacity safely reusable"],budgetCents:100});
  const slice={id:"slice",objective:"bounded fixture",dependencies:[],owner:"owner",scopes:["src/**"],checks:["check:unit"],budgetCents:100};
  await store.recommendPlan(mission.id,[slice],"owner-authored-fixture"); await store.approvePlan(mission.id);
  const grants=await Promise.all([store.claim(300,digest("policy"),["check:unit"]),other.claim(300,digest("policy"),["check:unit"])]);
  assert.equal(grants.filter(Boolean).length,1,"two real pools cannot double claim");
  const grant=grants.find(Boolean); assert(grant);
  const identity={missionId:mission.id,sliceId:slice.id,leaseEpoch:grant.epoch,controllerRunId:controllerRunIdFor({protocol:"orloom.worker-lease.v1",mission:{id:mission.id},slice:{id:slice.id},leaseEpoch:grant.epoch,planDigest:grant.planDigest,trustedCheckPolicyDigest:digest("policy")})};
  const binding={name:"orloom-postgres-proof",imageRef:`sha256:${"b".repeat(64)}`,labelsDigest:digest("labels")};
  await store.registerCancellationRuntimeBinding(identity,binding);
  await store.bindCancellationRuntimeContainer(identity,"c".repeat(64));
  await store.requestCancel(mission.id,"owner-request","prove safe cancellation");
  const at=new Date().toISOString();
  const observation={source:"orloom.trusted-docker-reconciler.v1",outcome:"unknown",identity,...binding,containerId:"c".repeat(64),observedAt:at};
  const entry={version:"orloom.runtime-journal.v2",identity,...binding,containerId:observation.containerId,state:"unknown",updatedAt:at,reconciliation:observation,history:[{state:"intent",at},{state:"created",at,containerId:observation.containerId},{state:"unknown",at,observation}]};
  assert.equal(await other.reconcileCancellationRuntime(entry),"quarantined");
  assert.equal((await store.getMission(mission.id)).slices[0].status,"cancel_requested");
  const absentAt=new Date().toISOString(),absent={...observation,outcome:"absent",observedAt:absentAt};
  const settled={...entry,state:"absent",updatedAt:absentAt,reconciliation:absent,history:[...entry.history,{state:"absent",at:absentAt,observation:absent}]};
  assert.equal(await other.reconcileCancellationRuntime({...settled,containerId:"f".repeat(64)}),"ignored");
  const results=await Promise.all([store.reconcileCancellationRuntime(settled),other.reconcileCancellationRuntime(settled)]);
  assert.deepEqual(results,["settled","settled"]);
  const restarted=new SqlMissionStore(second),record=await restarted.getMission(mission.id);
  assert.equal(record.mission.status,"cancelled"); assert.equal(record.mission.reservedCents,100);
  assert.equal(record.slices[0].status,"cancelled");
  assert.equal((await restarted.events(mission.id,0)).filter(event=>event.type==="slice.cancellation_settled").length,1);
  const next=await store.submit({repository:"fixture/next",baseSha:"a".repeat(40),objective:"reuse capacity",acceptance:["claim"],budgetCents:100});
  await store.recommendPlan(next.id,[slice],"owner-authored-fixture");await store.approvePlan(next.id);
  assert(await other.claim(300,digest("policy"),["check:unit"]),"capacity is released only after exact absence");
  console.log(JSON.stringify({result:"PASS",database:"actual isolated PostgreSQL",missionId:mission.id,twoPoolClaimWinners:1,settlementReplay:results,settledEvents:1,reservedCents:record.mission.reservedCents,capacityReused:true,liveProvider:false,runsc:false}));
} finally { await first.close();await second.close(); }
