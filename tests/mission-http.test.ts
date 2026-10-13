import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";

test("HTTP mission path authenticates roles, fences callbacks, and keeps verification gate closed",async()=>{
  const token="owner-session-secret",worker="worker-bootstrap-secret",policy="c".repeat(64),store=new MemoryMissionStore();
  await store.configureCapacity(1,"b".repeat(64),new Date(Date.now()+120_000).toISOString());
  const server=createControlPlane({mode:"local",port:0,sessionToken:token,workerToken:worker,capacitySlots:1,maxLanes:6,trustedCheckPolicy:["check:unit"],trustedCheckPolicyDigest:policy,workerMaxProviderCalls:2,workerMaxInputTokens:2000,workerMaxOutputTokens:1000,workerMaxWallSeconds:300,workerAllowedProviders:["provider-x"],workerAllowedModels:["model-x"]},new MemoryJobStore(),store);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  try{
    assert.equal((await fetch(`${base}/api/missions`,{method:"POST",body:"null"})).status,401);
    const login=await fetch(`${base}/session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});const cookie=login.headers.get("set-cookie")?.split(";")[0];assert(cookie);
    const closedIntegration={expectedIntegrationSha:"a".repeat(40),candidateSha:"d".repeat(40),leaseEpoch:1,requiredCheckIds:["check:unit"],reviewArtifactId:"review-1",reviewArtifactDigest:"e".repeat(64)};
    assert.equal((await fetch(`${base}/api/missions/missing/slices/first/integrate`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(closedIntegration)})).status,401,"integration requires owner session");
    assert.equal((await fetch(`${base}/api/missions/missing/slices/first/integrate`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(closedIntegration)})).status,503,"production integration remains closed without controller-only authority");
    assert.equal((await fetch(`${base}/api/worker/missions/missing/slices/first/integrate`,{method:"POST",headers:{authorization:`Bearer ${worker}`,"content-type":"application/json"},body:JSON.stringify(closedIntegration)})).status,404,"worker capability has no integration route");
    const bad=await fetch(`${base}/api/missions`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:"null"});assert.equal(bad.status,400);
    const missionResponse=await fetch(`${base}/api/missions`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({repository:"owner/repo",baseSha:"a".repeat(40),objective:"two-step",acceptance:["independent check"],budgetCents:200,untrustedExtra:"discard"})});assert.equal(missionResponse.status,201);const mission=await missionResponse.json();assert.equal("untrustedExtra" in mission,false);
    assert.equal((await fetch(`${base}/api/missions/${mission.id}/plan`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
    const malformedPlan=await fetch(`${base}/api/missions/${mission.id}/plan`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({slices:[{id:"cycle",objective:"x",dependencies:["cycle"],owner:"core",scopes:["src/a"],checks:["check:unit"],budgetCents:1}]})});assert.equal(malformedPlan.status,400);
    const plan=await fetch(`${base}/api/missions/${mission.id}/plan`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({recommendedBy:"pretend-sol",slices:[{id:"first",objective:"first",dependencies:[],owner:"core",scopes:["src/a.ts"],checks:["check:unit"],budgetCents:100},{id:"second",objective:"second",dependencies:["first"],owner:"core",scopes:["src/b.ts"],checks:["check:unit"],budgetCents:100}]})});assert.equal(plan.status,201);assert.equal((await plan.json()).recommendedBy,"owner-session");
    assert.equal((await fetch(`${base}/api/missions/${mission.id}/approve`,{method:"POST",headers:{cookie}})).status,200);
    assert.equal((await fetch(`${base}/api/worker/claim`,{method:"POST",headers:{authorization:"Bearer wrong"}})).status,401);
    const claimed=await fetch(`${base}/api/worker/claim`,{method:"POST",headers:{authorization:`Bearer ${worker}`}});assert.equal(claimed.status,200);const lease=await claimed.json();assert.equal(lease.mission.baseSha,"a".repeat(40));assert.equal(lease.executionLimits.reservedBudgetCents,100);assert.deepEqual(lease.executionLimits.allowedModels,["model-x"]);assert.match(lease.planDigest,/^[a-f0-9]{64}$/);
    const headers={authorization:`Bearer ${lease.capabilityToken}`,"x-orloom-lease-token":lease.leaseToken,"x-orloom-lease-epoch":String(lease.leaseEpoch),"content-type":"application/json"};
    assert.equal((await fetch(`${base}/api/worker/missions/${mission.id}/slices/${lease.slice.id}/result`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
    const wrongMission=await fetch(`${base}/api/worker/missions/not-the-mission/slices/${lease.slice.id}/result`,{method:"POST",headers,body:JSON.stringify({candidateSha:"d".repeat(40),evidenceRefs:[]})});assert.equal(wrongMission.status,409);
    const result=await fetch(`${base}/api/worker/missions/${mission.id}/slices/${lease.slice.id}/result`,{method:"POST",headers,body:JSON.stringify({candidateSha:"d".repeat(40),evidenceRefs:["worker://untrusted"]})});assert.equal(result.status,200);assert.equal((await result.json()).status,"awaiting_verification");
    const ownerAttempt=await fetch(`${base}/api/verifier/missions/${mission.id}/slices/${lease.slice.id}/integrate`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({candidateSha:"d".repeat(40),policyDigest:policy,evidenceRefs:["e"],integrationEvidenceRef:"i"})});assert.equal(ownerAttempt.status,404);
    const absentVerifier=await fetch(`${base}/api/verifier/missions/${mission.id}/slices/${lease.slice.id}/integrate`,{method:"POST",headers:{authorization:"Bearer anything","content-type":"application/json"},body:JSON.stringify({candidateSha:"d".repeat(40),policyDigest:policy,evidenceRefs:["untrusted"],integrationEvidenceRef:"untrusted"})});assert.equal(absentVerifier.status,404);
    const details=await (await fetch(`${base}/api/missions/${mission.id}`,{headers:{cookie}})).json();assert.equal(details.slices.find((s:any)=>s.id==="second").status,"waiting_dependency");
    assert.equal((await fetch(`${base}/api/worker/claim`,{method:"POST",headers:{authorization:`Bearer ${worker}`} })).status,204);
    const pending=await (await fetch(`${base}/api/missions/${mission.id}`,{headers:{cookie}})).json();assert.equal(pending.mission.status,"awaiting_verification");assert.equal(pending.mission.reservedCents,100);
    const replay=await (await fetch(`${base}/api/missions/${mission.id}/events?after=0`,{headers:{cookie}})).json();assert(replay.some((e:any)=>e.type==="slice.awaiting_verification"));
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
