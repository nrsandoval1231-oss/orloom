import { createHash } from "node:crypto";
import type { ArtifactStore, GitHubInstallationClient } from "../../adapters/src/providers.js";
import type { DeliveryIntentV1, DeliveryRequestV1, MissionStore } from "../../contracts/src/mission.js";
import { MissionConflictError } from "../../contracts/src/mission.js";
import { receiptDigestV1, trustedCheckRequestDigestV1, type CheckCertificateV1 } from "../../contracts/src/verification.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import type { LocalIntegrator } from "./local.js";

const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const sha1=/^[a-f0-9]{40}$/;
const sha256=/^[a-f0-9]{64}$/;
export interface DeliveryCommandV1 {version:"orloom.delivery-command.v1";missionId:string;sliceId:string;leaseEpoch:number;integratedSha:string;treeSha:string;reviewArtifactId:string;reviewArtifactDigest:string;idempotencyKey:string;}
export interface DeliveryPolicy {repository:string;appId:number;installationId:number;baseRef:string;baseSha:string;protectedRefs:string[];checkIds:string[];policyVersion:string;policyDigest:string;imageDigest:string;checkName:string;}
export interface DeliveryReviewArtifactReader {read(artifactId:string):Promise<Buffer|null>;}
export interface DeliveryAuthority {integrator:LocalIntegrator;reviews:DeliveryReviewArtifactReader;artifacts:ArtifactStore;github:GitHubInstallationClient;}

function validateCommand(x:DeliveryCommandV1,p:DeliveryPolicy){const fields=["version","missionId","sliceId","leaseEpoch","integratedSha","treeSha","reviewArtifactId","reviewArtifactDigest","idempotencyKey"];if(!x||Object.keys(x).length!==fields.length||fields.some(k=>!Object.hasOwn(x,k))||x.version!=="orloom.delivery-command.v1"||!/^[-a-f0-9]{36}$/.test(x.missionId)||! /^[A-Za-z0-9._:-]{1,120}$/.test(x.sliceId)||!Number.isSafeInteger(x.leaseEpoch)||x.leaseEpoch<1||!sha1.test(x.integratedSha)||!sha1.test(x.treeSha)||!sha256.test(x.reviewArtifactDigest)||! /^[A-Za-z0-9._:-]{16,180}$/.test(x.idempotencyKey)||! /^[A-Za-z0-9._:-]{1,180}$/.test(x.reviewArtifactId)||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository)||!Number.isSafeInteger(p.appId)||p.appId<1||!Number.isSafeInteger(p.installationId)||p.installationId<1||!p.baseRef||!sha1.test(p.baseSha)||!p.policyVersion||!sha256.test(p.policyDigest)||!sha256.test(p.imageDigest)||!p.checkIds.includes("node-repo-suite-v1")||new Set(p.checkIds).size!==p.checkIds.length||!p.checkName||!Array.isArray(p.protectedRefs))throw new MissionConflictError("Delivery request or immutable controller delivery policy is invalid");}
const checkIdFor=(missionId:string,sliceId:string,epoch:number,sha:string)=>`${missionId}:${sliceId}:${epoch}:${sha}`;
const branchFor=(missionId:string,sliceId:string)=>`orloom/delivery/${missionId}/${hash(sliceId).slice(0,12)}`;
function assertRemote(remote:{sha:string;treeSha:string},sha:string,tree:string){if(remote.sha!==sha||remote.treeSha!==tree)throw new MissionConflictError("Remote delivery branch does not match the integrated commit and tree");}
function assertBase(remote:{sha:string;treeSha:string},sha:string){if(remote.sha!==sha)throw new MissionConflictError("Remote base ref no longer matches the approved pinned commit");}
function assertPr(pr:{number:number;draft:boolean;state:string;merged:boolean;headRepository:string|null;headRef:string;headSha:string;baseRepository:string|null;baseRef:string;baseSha:string},request:DeliveryRequestV1){if(!Number.isSafeInteger(pr.number)||pr.number<1||!pr.draft||pr.state!=="open"||pr.merged||pr.headRepository?.toLowerCase()!==request.repository.toLowerCase()||pr.headRef!==request.branch||pr.headSha!==request.integratedSha||pr.baseRepository?.toLowerCase()!==request.repository.toLowerCase()||pr.baseRef!==request.baseRef||pr.baseSha!==request.baseSha)throw new MissionConflictError("Draft PR readback differs from the exact approved delivery identity");}
async function verifyArtifact(store:ArtifactStore,r:{key:string;sha256:string;bytes:number}){if(!sha256.test(r.sha256)||r.key!==`sha256/${r.sha256}`||!Number.isSafeInteger(r.bytes)||r.bytes<0)throw new MissionConflictError("Trusted evidence artifact reference is malformed");const bytes=await store.get(r.key);if(bytes.byteLength!==r.bytes||hash(bytes)!==r.sha256)throw new MissionConflictError("Trusted evidence artifact could not be read back by its content digest");}
function asRecord(x:unknown):Record<string,unknown>{if(!x||typeof x!=="object"||Array.isArray(x))throw new MissionConflictError("Retained trusted receipt is malformed");return x as Record<string,unknown>;}
async function validateCert(store:MissionStore,artifacts:ArtifactStore,certificate:CheckCertificateV1,request:DeliveryRequestV1,policy:DeliveryPolicy){
  const attempt=await store.getTrustedAttempt?.(certificate.attemptId),receipt=attempt?.receipt;if(!attempt||attempt.purpose!=="final"||attempt.outcome!=="pass"||!receipt||receipt.outcome!=="pass"||receipt.exitCode!==0||receipt.receiptDigest!==certificate.receiptDigest)throw new MissionConflictError("Retained final PASS attempt and receipt are unavailable");
  const req=attempt.request;if(certificate.missionId!==request.missionId||certificate.sliceId!==request.sliceId||certificate.leaseEpoch!==request.leaseEpoch||certificate.repository!==request.repository||certificate.candidateSha!==request.integratedSha||certificate.localHeadSha!==request.integratedSha||certificate.checkId!==req.checkId||certificate.policyVersion!==policy.policyVersion||certificate.policyDigest!==policy.policyDigest||req.missionId!==request.missionId||req.sliceId!==request.sliceId||req.leaseEpoch!==request.leaseEpoch||req.repository!==request.repository||req.candidateSha!==request.integratedSha||req.expectedLocalHeadSha!==request.integratedSha||req.policyDigest!==policy.policyDigest||req.policyVersion!==policy.policyVersion||req.verifierImageDigest!==policy.imageDigest||req.checkId!==certificate.checkId||!request.checkIds.includes(certificate.checkId)||canonicalJson(req)!==canonicalJson(receipt.request)||trustedCheckRequestDigestV1(req)!==trustedCheckRequestDigestV1(receipt.request)||receipt.receiptDigest!==receiptDigestV1(receipt)||receipt.receiptDigest!==certificate.receiptDigest)throw new MissionConflictError("Retained certificate does not bind the integrated commit, lease, policy, image, and receipt");
  await Promise.all([verifyArtifact(artifacts,receipt.stdout),verifyArtifact(artifacts,receipt.stderr),verifyArtifact(artifacts,receipt.inputManifest)]);
}

function assertCheck(check:{id:number;headSha:string;name:string;externalId:string|null;conclusion:string|null;appId:number|null},request:DeliveryRequestV1,name:string,externalId:string){
  if(!Number.isSafeInteger(check.id)||check.id<1||check.headSha!==request.integratedSha||check.name!==name||check.externalId!==externalId||check.conclusion!=="success"||check.appId!==request.appId)throw new MissionConflictError("Check response or readback differs from the configured App and retained certificate identity");
}
function deliveryRequest(command:DeliveryCommandV1,policy:DeliveryPolicy,branch:string,checkIds:string[]):DeliveryRequestV1{
  return{version:"orloom.delivery-request.v1",missionId:command.missionId,sliceId:command.sliceId,leaseEpoch:command.leaseEpoch,integratedSha:command.integratedSha,treeSha:command.treeSha,repository:policy.repository.toLowerCase(),appId:policy.appId,installationId:policy.installationId,branch,baseRef:policy.baseRef,baseSha:policy.baseSha,checkIds,reviewArtifactId:command.reviewArtifactId,reviewArtifactDigest:command.reviewArtifactDigest,idempotencyKey:command.idempotencyKey};
}

/** Publish retained evidence only after durable, exact-identity effect claims. This function never pushes Git data. */
export async function deliverIntegratedCommit(command:DeliveryCommandV1,policy:DeliveryPolicy,authority:DeliveryAuthority,store:MissionStore):Promise<DeliveryIntentV1>{
  validateCommand(command,policy);
  if(!authority?.integrator||!authority.reviews||!authority.artifacts||!authority.github||!store.getIntegratedIntent||!store.getIntegratedCertificate||!store.createDeliveryIntent||!store.updateDeliveryIntent||!store.getDeliveryIntent||!store.claimDeliveryEffect||!store.observeDeliveryEffect||!store.getTrustedAttempt)throw new MissionConflictError("Delivery is closed without controller-owned local, retained evidence, PostgreSQL, review, and GitHub services");
  if(authority.github.appId!==policy.appId)throw new MissionConflictError("Configured GitHub App identity differs from the immutable delivery policy");
  const repository=policy.repository.toLowerCase();
  if(authority.integrator.repositoryIdentity!==repository)throw new MissionConflictError("Local integration repository is not the configured delivery repository");
  const mission=await store.getMission(command.missionId);
  const slice=mission?.slices.find(item=>item.id===command.sliceId);
  if(!mission||!slice||!mission.plan?.approvedAt||slice.status!=="verified"||slice.leaseEpoch!==command.leaseEpoch||slice.candidateSha!==command.integratedSha||canonicalJson([...slice.checks].sort())!==canonicalJson([...policy.checkIds].sort()))throw new MissionConflictError("Delivery does not match a verified, approved integrated slice");
  for(const reference of slice.evidenceRefs){
    const match=/^sha256[:/]([a-f0-9]{64})$/.exec(reference);
    if(!match)throw new MissionConflictError("Integrated slice evidence is not content-addressed R2 evidence");
    const bytes=await authority.artifacts.get("sha256/"+match[1]);
    if(hash(bytes)!==match[1])throw new MissionConflictError("Integrated slice R2 evidence did not match its content digest");
  }
  const checkIds=[...policy.checkIds].sort();
  const integration=await store.getIntegratedIntent(command.missionId,command.sliceId,command.leaseEpoch);
  if(!integration||integration.state!=="integrated"||integration.observedIntegrationSha!==command.integratedSha||integration.candidateSha!==command.integratedSha||integration.treeSha!==command.treeSha||integration.reviewArtifactId!==command.reviewArtifactId||integration.reviewArtifactDigest!==command.reviewArtifactDigest||canonicalJson([...integration.requiredCheckIds].sort())!==canonicalJson(checkIds))throw new MissionConflictError("Integrated intent does not retain the exact commit, tree, review, and check set");
  if(await authority.integrator.readRef()!==command.integratedSha)throw new MissionConflictError("Dedicated local integration ref moved after integration");
  const inspected=await authority.integrator.inspect({expectedRefSha:integration.expectedIntegrationSha,candidateSha:command.integratedSha,scopes:slice.scopes});
  if(inspected.candidateSha!==command.integratedSha||inspected.treeSha!==command.treeSha||await authority.integrator.readRef()!==command.integratedSha)throw new MissionConflictError("Dedicated local integration tree changed after integration");
  const reviewBytes=await authority.reviews.read(command.reviewArtifactId);
  if(!reviewBytes||hash(reviewBytes)!==command.reviewArtifactDigest)throw new MissionConflictError("Retained independent review artifact is missing or changed");
  let review:unknown;try{review=JSON.parse(reviewBytes.toString("utf8"));}catch{throw new MissionConflictError("Retained independent review is malformed");}
  const reviewRecord=asRecord(review);
  if(reviewRecord.version!=="orloom.independent-review.v1"||reviewRecord.verdict!=="PASS"||reviewRecord.candidateSha!==command.integratedSha||reviewRecord.treeSha!==command.treeSha||reviewRecord.builder!==slice.owner||reviewRecord.reviewer===reviewRecord.builder||!Array.isArray(reviewRecord.scopes)||canonicalJson(reviewRecord.scopes.slice().sort())!==canonicalJson(slice.scopes.slice().sort()))throw new MissionConflictError("Independent PASS review does not bind this integrated candidate and scope");
  const request=deliveryRequest(command,policy,branchFor(command.missionId,command.sliceId),checkIds);
  if(policy.protectedRefs.includes(request.branch)||request.branch==="main"||request.branch==="refs/heads/main"||request.branch==="feat/worker-broker")throw new MissionConflictError("Delivery branch conflicts with a protected or reserved ref");
  const certificateBinding=deliveryRequest(command,policy,"",checkIds);
  for(const id of checkIds){
    const certificate=await store.getIntegratedCertificate(command.missionId,command.sliceId,command.leaseEpoch,id);
    if(!certificate||certificate.scope!=="local-exact-commit"||certificate.candidateSha!==command.integratedSha||certificate.localHeadSha!==command.integratedSha||!integration.certificateIds.includes(certificate.certificateId)||!integration.certificateDigests.includes(hash(canonicalJson(certificate))))throw new MissionConflictError("A mandatory final certificate is absent or stale after integration");
    await validateCert(store,authority.artifacts,certificate,certificateBinding,policy);
  }
  let intent=await store.getDeliveryIntent(request);
  intent??=await store.createDeliveryIntent(request);
  const markUnknown=async(reason:string):Promise<never>=>{
    try{await store.updateDeliveryIntent!(request,{state:"unknown"});}catch{/* Keep the original unresolved outcome. */}
    throw new MissionConflictError(reason);
  };
  const checkName=policy.checkName;
  const externalId=checkIdFor(command.missionId,command.sliceId,command.leaseEpoch,command.integratedSha);
  const remote=()=>authority.github.inspectBranch(policy.installationId,repository,request.branch);
  const base=()=>authority.github.inspectBranch(policy.installationId,repository,policy.baseRef);
  const verifyRemoteAndBase=async()=>{
    assertRemote(await remote(),command.integratedSha,command.treeSha);
    assertBase(await base(),policy.baseSha);
  };
  try{await verifyRemoteAndBase();}catch{return markUnknown("Remote branch or pinned base readback drifted before delivery");}

  const checkClaim=await store.claimDeliveryEffect(request,"check");
  let checks:Array<{id:number;headSha:string;name:string;externalId:string|null;conclusion:string|null;appId:number|null}>;
  try{checks=await authority.github.listCheckRuns(policy.installationId,repository,command.integratedSha,checkName,externalId);}catch{return markUnknown("GitHub Check reconciliation readback failed");}
  if(checks.length>1)return markUnknown("Multiple GitHub Checks match this delivery intent");
  let check=checks[0];
  if(check){
    try{
      assertCheck(check,request,checkName,externalId);
      if(checkClaim.externalId&&checkClaim.externalId!==String(check.id))throw new MissionConflictError("Check readback differs from the durable effect identity");
      await verifyRemoteAndBase();
      check=await authority.github.getCheckRun(policy.installationId,repository,check.id);
      assertCheck(check,request,checkName,externalId);
      await verifyRemoteAndBase();
      await store.observeDeliveryEffect!(request,"check",String(check.id));
      if(intent.state!=="pr_created")intent=await store.updateDeliveryIntent!(request,{state:"check_created",checkRunId:String(check.id),observedRemoteSha:command.integratedSha});
    }catch{return markUnknown("Existing Check did not pass exact configured-App and commit readback");}
  }else if(!checkClaim.claimed){
    return markUnknown("A prior Check write may have occurred; no exact Check is visible and create was not retried");
  }else{
    try{
      await verifyRemoteAndBase();
      const created=await authority.github.createDeliveryCheck(policy.installationId,repository,command.integratedSha,checkName,externalId,"Orloom certified repository suite","Orloom retained a final PASS certificate for "+command.integratedSha+"; independent review "+command.reviewArtifactDigest+". This Check publishes existing Orloom evidence and does not execute CI.");
      assertCheck(created,request,checkName,externalId);
      await verifyRemoteAndBase();
      check=await authority.github.getCheckRun(policy.installationId,repository,created.id);
      assertCheck(check,request,checkName,externalId);
      await verifyRemoteAndBase();
      await store.observeDeliveryEffect!(request,"check",String(check.id));
      intent=await store.updateDeliveryIntent!(request,{state:"check_created",checkRunId:String(check.id),observedRemoteSha:command.integratedSha});
    }catch{return markUnknown("Check write or separate Check readback is unresolved; create will not be repeated");}
  }

  if(await authority.integrator.readRef()!==command.integratedSha)return markUnknown("Local integration ref changed after Check publication");
  try{await verifyRemoteAndBase();}catch{return markUnknown("Remote branch or pinned base drifted after Check publication");}
  const prClaim=await store.claimDeliveryEffect(request,"pull_request");
  let pullRequests;
  try{pullRequests=await authority.github.listPullRequests(policy.installationId,repository,request.branch,policy.baseRef);}catch{return markUnknown("Draft PR reconciliation readback failed");}
  if(pullRequests.length>1)return markUnknown("Multiple pull requests match the exact delivery head and base");
  let pr=pullRequests[0];
  if(pr){
    try{
      assertPr(pr,request);
      if(prClaim.externalId&&prClaim.externalId!==String(pr.number))throw new MissionConflictError("Draft PR readback differs from the durable effect identity");
      await verifyRemoteAndBase();
      pr=await authority.github.getPullRequest(policy.installationId,repository,pr.number);
      assertPr(pr,request);
      await verifyRemoteAndBase();
      await store.observeDeliveryEffect!(request,"pull_request",String(pr.number));
    }catch{return markUnknown("Existing PR did not pass exact open, unmerged draft readback");}
  }else if(!prClaim.claimed){
    return markUnknown("A prior PR write may have occurred; no exact PR is visible and create was not retried");
  }else{
    try{
      await verifyRemoteAndBase();
      const created=await authority.github.createDraftPullRequest(policy.installationId,repository,request.branch,policy.baseRef,
        "Orloom: "+mission.mission.objective.slice(0,100),
        "Automated delivery of the independently reviewed integrated commit "+command.integratedSha+".\n\nTree: "+command.treeSha+"\nReview artifact SHA-256: "+command.reviewArtifactDigest+"\nRetained final checks: "+checkIds.join(", ")+"\n\nGitHub is publishing retained Orloom evidence; it did not execute CI.");
      assertPr(created,request);
      await verifyRemoteAndBase();
      pr=await authority.github.getPullRequest(policy.installationId,repository,created.number);
      assertPr(pr,request);
      await verifyRemoteAndBase();
      await store.observeDeliveryEffect!(request,"pull_request",String(pr.number));
    }catch{return markUnknown("Draft PR write or separate PR readback is unresolved; create will not be repeated");}
  }
  if(!check)return markUnknown("A Check was not retained after exact readback");
  if(intent.state==="pr_created"){
    if(intent.pullRequestNumber!==pr.number||intent.checkRunId!==String(check.id))return markUnknown("Completed delivery identities differ from exact replay readback");
    return intent;
  }
  return store.updateDeliveryIntent!(request,{state:"pr_created",checkRunId:String(check.id),pullRequestNumber:pr.number,observedRemoteSha:command.integratedSha});
}

function canonical(value:unknown):string{return canonicalJson(value);}
