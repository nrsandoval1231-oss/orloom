import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { evaluateOwnerCancellation, evaluateOwnerReadiness } from "../apps/control-plane/src/owner-readiness.js";
import { projectLoom } from "../apps/control-plane/src/loom-projection.js";
import type { Config } from "../packages/config/src/config.js";
import type { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import type { Mission, MissionEvent, MissionPlan, MissionSlice } from "../packages/contracts/src/mission.js";

const digest="a".repeat(64), sha="b".repeat(40), checkDigest=createHash("sha256").update('["check:unit"]').digest("hex");
const mission:Mission={id:"mission-1",repository:"owner/repo",baseSha:sha,objective:"finish safely",acceptance:["check"],budgetCents:100,status:"ready",reservedCents:0,createdAt:"2026-10-15T00:00:00.000Z"};
const plan:MissionPlan={missionId:mission.id,slices:[{id:"slice-1",objective:"work",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100}],recommendedBy:"owner",recommendedAt:mission.createdAt,approvedAt:mission.createdAt};
const slices:MissionSlice[]=[{...plan.slices[0]!,missionId:mission.id,status:"ready",leaseEpoch:2,leaseToken:null,leaseExpiresAt:null,candidateSha:null,evidenceRefs:[]}];
const config:Config={mode:"cloud",port:3000,sessionToken:"never serialize me",workerToken:"worker-secret",capacitySlots:1,maxLanes:1,capacityEvidenceDigest:digest,capacityEvidenceExpiresAt:"2026-10-16T00:00:00.000Z",trustedCheckPolicy:["check:unit"],trustedCheckPolicyDigest:checkDigest,trustedVerifierId:"verifier",trustedVerifierImageDigest:digest,trustedVerificationPolicyVersion:"v1",workerMaxProviderCalls:1,workerMaxInputTokens:1,workerMaxOutputTokens:1,workerMaxWallSeconds:1,workerAllowedProviders:["provider"],workerAllowedModels:["model"],integrationEnabled:true,deliveryEnabled:true,integrationBareRepository:"C:/private/repo",reviewArtifactRoot:"C:/private/reviews",deliveryPolicyFile:"C:/private/policy"};
const coordinatorBinding={allowedChecks:["check:unit"],policyDigest:digest,policyVersion:"v1",imageDigest:digest,verifierId:"verifier",leasePolicyDigest:checkDigest};
const coordinator={integrationBinding:()=>coordinatorBinding} as unknown as TrustedCheckCoordinator;
const authorities={verification:coordinator,integration:true,delivery:true};
const event=(cursor:number,type:string,data:Record<string,unknown>):MissionEvent=>({cursor,type,data,missionId:mission.id,createdAt:mission.createdAt});

test("owner readiness is bounded, allowlisted, and validates expiring capacity and approved plan",()=>{
  const ready=evaluateOwnerReadiness(config,authorities,mission,plan,slices,Date.parse("2026-10-15T12:00:00.000Z"));
  assert.equal(ready.state,"ready");assert.equal(ready.meaning,"Control-plane prerequisites only; no live worker, runtime, provider, or image attestation.");
  assert.equal(ready.configuration.baseSha,sha);assert.equal(ready.configuration.planDigest?.length,64);assert.equal(ready.configuration.checkPolicyDigest,checkDigest);
  assert.equal(ready.liveExecution,"unverified");assert(!JSON.stringify(ready).includes("worker-secret"));assert(!JSON.stringify(ready).includes("private"));assert(!JSON.stringify(ready).includes("sessionToken"));
  assert.equal(evaluateOwnerReadiness(config,authorities,mission,plan,slices,Date.parse("2026-10-17T00:00:00.000Z")).state,"unverified");
  assert.equal(evaluateOwnerReadiness(config,authorities,mission,{...plan,approvedAt:null},slices,Date.parse("2026-10-15T12:00:00.000Z")).state,"unverified");
  assert.equal(evaluateOwnerReadiness(config,{...authorities,delivery:false},mission,plan,slices,Date.parse("2026-10-15T12:00:00.000Z")).state,"unverified");
});

test("owner cancellation recognizes only exact current-epoch durable settlement events",()=>{
  const requested=event(1,"mission.cancellation_requested",{ownerRequestId:"stop"});
  const settled=event(2,"slice.cancellation_settled_before_runtime",{sliceId:"slice-1",leaseEpoch:2});
  const stale=event(3,"slice.cancellation_settled",{sliceId:"slice-1",leaseEpoch:1});
  const current=event(4,"slice.cancellation_settled",{sliceId:"slice-1",leaseEpoch:2});
  assert.equal(evaluateOwnerCancellation(mission,[{...slices[0]!,status:"cancel_requested"}],[requested]).slices[0]?.state,"requested");
  assert.equal(evaluateOwnerCancellation(mission,slices,[requested,stale]).slices[0]?.state,"quarantined-unknown");
  assert.equal(evaluateOwnerCancellation(mission,[{...slices[0]!,status:"cancelled"}],[requested,settled]).slices[0]?.state,"pre-runtime-settled");
  assert.equal(evaluateOwnerCancellation(mission,[{...slices[0]!,status:"cancelled"}],[requested,current]).slices[0]?.state,"runtime-absence-settled");
  const contradiction=evaluateOwnerCancellation(mission,[{...slices[0]!,status:"cancel_requested"}],[requested,current]);
  assert.equal(contradiction.slices[0]?.state,"quarantined-unknown");assert.equal(contradiction.state,"quarantined-unknown");
  assert.equal(evaluateOwnerCancellation(mission,slices,[]).state,"none");
});

test("cancelled or uncertain missions cannot report execution prerequisites ready",()=>{
  const now=Date.parse("2026-10-15T12:00:00.000Z");
  for(const status of ["cancelling","cancelled","unknown"] as const){
    const view=evaluateOwnerReadiness(config,authorities,{...mission,status},plan,slices,now);
    assert.equal(view.state,"unverified",status);
    assert(view.reasons.some(reason=>reason.includes("mission state")));
  }
  assert.equal(evaluateOwnerReadiness(config,authorities,null,null,null,now).state,"unavailable");
  assert.equal(evaluateOwnerReadiness({...config,trustedCheckPolicyDigest:digest},authorities,mission,plan,slices,now).state,"unverified");
});

test("readiness requires the coordinator's immutable binding to match configured verifier and planned checks",()=>{
  const now=Date.parse("2026-10-15T12:00:00.000Z");
  const binding={allowedChecks:["node-repo-suite-v1"],policyDigest:digest,policyVersion:"v1",imageDigest:digest,verifierId:"verifier",leasePolicyDigest:checkDigest};
  const coordinator={integrationBinding:()=>binding};
  const projected=evaluateOwnerReadiness(config,{verification:coordinator as unknown as TrustedCheckCoordinator,integration:true,delivery:true},mission,plan,slices,now);
  assert.equal(projected.state,"unverified","broad configured allowlist cannot substitute for coordinator support of each approved check");
  assert.equal(projected.configuration.verificationConfigured,false);
  const inconsistent={...binding,leasePolicyDigest:digest};
  const mismatched=evaluateOwnerReadiness(config,{verification:{integrationBinding:()=>inconsistent} as unknown as TrustedCheckCoordinator,integration:true,delivery:true},mission,plan,slices,now);
  assert.equal(mismatched.state,"unverified","a present but inconsistent coordinator binding must fail closed");
  assert.equal(mismatched.configuration.verificationConfigured,false);
  const missing=evaluateOwnerReadiness(config,{verification:{} as unknown as TrustedCheckCoordinator,integration:true,delivery:true},mission,plan,slices,now);
  assert.equal(missing.state,"unverified","a truthy object without binding evidence is not a coordinator");
  const broadChecks=["check:unit","node-repo-suite-v1"], broadDigest=createHash("sha256").update(JSON.stringify(broadChecks)).digest("hex");
  const broadConfig={...config,trustedCheckPolicy:broadChecks,trustedCheckPolicyDigest:broadDigest};
  const subset={integrationBinding:()=>({...coordinatorBinding,leasePolicyDigest:broadDigest})} as unknown as TrustedCheckCoordinator;
  const unsupportedPlan={...plan,slices:[{...plan.slices[0]!,checks:["node-repo-suite-v1"]}]};
  const unsupportedSlices=[{...slices[0]!,checks:["node-repo-suite-v1"]}];
  const unsupported=evaluateOwnerReadiness(broadConfig,{...authorities,verification:subset},mission,unsupportedPlan,unsupportedSlices,now);
  assert.equal(unsupported.configuration.verificationConfigured,true,"a valid configured subset is still an available coordinator");
  assert.equal(unsupported.state,"unverified","operator policy permission does not prove actual coordinator support");
  assert.equal(evaluateOwnerReadiness(broadConfig,{...authorities,verification:subset},mission,plan,slices,now).state,"ready","supported planned checks need not use every operator-permitted check");
});

test("cancellation displays direct unleased tombstones and rejects duplicate current proof",()=>{
  const requested=event(1,"mission.cancellation_requested",{ownerRequestId:"stop"});
  const cancelled={...mission,status:"cancelled" as const};
  const noRuntime=[{...slices[0]!,status:"cancelled" as const,leaseEpoch:0}];
  assert.equal(evaluateOwnerCancellation(cancelled,noRuntime,[requested]).state,"pre-runtime-settled");
  const proof=event(2,"slice.cancellation_settled_before_runtime",{sliceId:"slice-1",leaseEpoch:2});
  const duplicate={...proof,cursor:3};
  assert.equal(evaluateOwnerCancellation(cancelled,[{...slices[0]!,status:"cancelled"}],[requested,proof,duplicate]).state,"quarantined-unknown");
  assert.equal(evaluateOwnerCancellation(cancelled,[{...slices[0]!,status:"verified"}],[requested]).state,"none");
});

test("recovery and delivery timeline retains recorded identity without inferring completion",()=>{
  const observedRemoteSha="c".repeat(40);
  const rows=[event(1,"mission.submitted",{}),event(2,"check.recovery_unknown",{sliceId:"slice-1",leaseEpoch:2,attemptId:"attempt-1",strategyId:"bounded-repair",checkId:"check:unit",candidateSha:sha}),event(3,"delivery.pending",{sliceId:"slice-1",leaseEpoch:2,integratedSha:sha,treeSha:"d".repeat(40)}),event(4,"delivery.check_observed",{sliceId:"slice-1",leaseEpoch:2,checkRunId:"check-8",observedRemoteSha}),event(5,"delivery.pull_request_observed",{sliceId:"slice-1",leaseEpoch:2,pullRequestNumber:7,checkRunId:"check-8",observedRemoteSha}),event(6,"delivery.unknown",{sliceId:"slice-1",leaseEpoch:2,observedRemoteSha:null}),event(7,"delivery.unknown",{sliceId:"slice-1",leaseEpoch:2,observedRemoteSha:"not-a-sha"})];
  const view=projectLoom(mission,plan,slices,rows);
  assert.equal(view.closed,false);
  assert.equal(view.events[1]?.label,"Recovery check unknown");
  assert(view.events[1]?.references.some(ref=>ref.id==="attempt-1"));
  assert(view.events[1]?.references.some(ref=>ref.id==="bounded-repair"));
  assert(view.events[2]?.references.some(ref=>ref.kind==="integration"&&ref.id===sha));
  assert(view.events[3]?.references.some(ref=>ref.kind==="delivery"&&ref.id===observedRemoteSha),"check observation must retain the remote revision that was read back");
  assert(view.events[4]?.references.some(ref=>ref.kind==="delivery"&&ref.id==="pull-request:7"));
  assert(view.events[4]?.references.some(ref=>ref.kind==="delivery"&&ref.id===observedRemoteSha),"PR observation must retain the remote revision that was read back");
  assert(!view.events[4]?.references.some(ref=>ref.kind==="integration"),"SQL observation rows contain observedRemoteSha, not pending integratedSha");
  assert(!view.events[5]?.references.some(ref=>ref.kind==="delivery"),"UNKNOWN readback with no remote SHA must not invent one");
  assert(!view.events[6]?.references.some(ref=>ref.kind==="delivery"&&ref.id==="not-a-sha"),"malformed remote revisions are not projected as references");
  assert.deepEqual(projectLoom(mission,plan,slices,rows),view,"reconstruction has no synthetic clock/progress");
});
