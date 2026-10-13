import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { MissionGovernor } from "../packages/governor/src/governor.js";
import type { DeliveryCommandV1, DeliveryPolicy } from "../packages/integration/src/delivery.js";

const sha="a".repeat(40),digest="b".repeat(64);
const command:DeliveryCommandV1={version:"orloom.delivery-command.v1",missionId:"11111111-1111-4111-8111-111111111111",sliceId:"slice",leaseEpoch:1,integratedSha:sha,treeSha:sha,reviewArtifactId:"review-1",reviewArtifactDigest:digest,idempotencyKey:"delivery-key-00000001"};
const policy:DeliveryPolicy={repository:"acme/orloom",appId:1,installationId:7,baseRef:"main",baseSha:sha,protectedRefs:["main","feat/pr2"],checkIds:["node-repo-suite-v1"],policyVersion:"v1",policyDigest:digest,imageDigest:digest,checkName:"Orloom certified suite"};

test("delivery rejects public repo/ref overrides and stays closed when R2 or GitHub App authority is absent",async()=>{
  const governor=new MissionGovernor(new MemoryMissionStore(),{maxLanes:1,capacitySlots:0,leaseSeconds:300,trustedCheckPolicyDigest:digest});
  let calls=0;const noAuthority={integrator:{repositoryIdentity:"acme/orloom"},reviews:{read:async()=>null},artifacts:{get:async()=>{calls++;throw new Error("unavailable");}},github:{inspectBranch:async()=>{calls++;throw new Error("unavailable");}}} as never;
  await assert.rejects(governor.deliverIntegratedCommit({...command,repository:"other/repo"} as DeliveryCommandV1,policy,noAuthority),/invalid/);
  await assert.rejects(governor.deliverIntegratedCommit(command,policy,{} as never),/closed without controller-owned/);
  assert.equal(calls,0,"missing live authority must not make external calls");
});

test("delivery migration creates a constrained durable intent ledger",async()=>{
  const db=new PGlite();try{await db.exec(await readFile("db/migrations/007_delivery.sql","utf8"));const columns=await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='mission_delivery_intents' ORDER BY ordinal_position");assert.deepEqual(columns.rows.map(x=>(x as {column_name:string}).column_name),["mission_id","slice_id","lease_epoch","request","state","check_run_id","pull_request_number","observed_remote_sha","created_at","updated_at"]);await assert.rejects(db.query("INSERT INTO mission_delivery_intents(mission_id,slice_id,lease_epoch,request,state) VALUES($1,$2,$3,$4::jsonb,$5)",["11111111-1111-4111-8111-111111111111","s",1,"{}","completed"]));}finally{await db.close();}
});
