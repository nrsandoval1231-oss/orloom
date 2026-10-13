import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DecisionSnapshotV1, JudgmentV1 } from "../../judgment/src/types.js";
import { ClaimAdvice, IntegrationRequestV1, Lane, LessonCandidate, LessonValidationChallenge, Mission, MissionConflictError, MissionInput, MissionPlan, MissionSlice, MissionStore, MissionValidationError, ProgressReceipt, ProgressV1, RecoveryAttemptBinding, RecoveryProgress, SchedulingDecisionRecord, SchedulingSnapshot, SchedulingTokenUsage, SliceInput, TrustedStrategyPolicy, validateMission, validatePlan } from "../../contracts/src/mission.js";
import { CheckCertificateV1, parseTrustedCheckRequestV1, TRUSTED_CHECK_LIMITS, TrustedCheckReceiptV1, TrustedCheckRequestV1, TrustedCheckService } from "../../contracts/src/verification.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import type { LearningActivation } from "../../learning/src/activation.js";
import { challengeTrustedLesson, rejectTrustedLessonReadback, type ChallengedAttempt } from "../../learning/src/challenger.js";
import { rankSchedulingChoices, schedulingSnapshotDigest } from "../../contracts/src/scheduling.js";
import type { LocalIntegrator } from "../../integration/src/local.js";

export interface TrustedCheckRunner {
  prepareBundle(repository:string,baseSha:string,candidateSha:string):Promise<{digest:string;manifest:Buffer;files:Map<string,Buffer>}>;
  observeHead(repository:string):Promise<{sha:string;observedAt:string;digest:string}>;
  run(request:TrustedCheckRequestV1,bundle:{digest:string;manifest:Buffer;files:Map<string,Buffer>}):Promise<TrustedCheckReceiptV1>;
  verifyArtifacts(receipt:TrustedCheckReceiptV1):Promise<{stdout:Buffer;stderr:Buffer;manifest:Buffer}>;
}
export class TrustedCheckCoordinator implements TrustedCheckService {
  private readonly pending=new Map<string,{capability:string;bundle:{digest:string;manifest:Buffer;files:Map<string,Buffer>}}>();
  constructor(private readonly store:MissionStore,private readonly runner:TrustedCheckRunner,private readonly settings:{imageDigest:string;verifierId:string;policyDigest:string;leasePolicyDigest:string;policyVersion:string;allowedChecks:string[];attemptLifetimeMs:number},private readonly clock=()=>new Date()){
    if(!Number.isSafeInteger(settings.attemptLifetimeMs)||settings.attemptLifetimeMs<1||settings.attemptLifetimeMs>TRUSTED_CHECK_LIMITS.maxLifetimeMs)throw new Error("trusted check attempt lifetime is outside contract bounds");
  }
  async prepare(missionId:string,sliceId:string,checkId:string):Promise<TrustedCheckRequestV1>{
    return this.prepareShared({missionId,sliceId,checkId,purpose:"final"});
  }
  private async prepareShared(input:{missionId:string;sliceId:string;checkId:string;purpose:"final"}|{missionId:string;sliceId:string;checkId:string;purpose:"recovery";epoch:number;leaseToken:string;capabilityToken:string;candidateSha:string;targetCheckId:string;strategyId:string;ordinal:number;recoveryPolicyDigest:string}):Promise<TrustedCheckRequestV1>{
    if(!this.store.createVerificationAttempt||!this.store.submitVerification)throw new MissionConflictError("Trusted verification is disabled without the PostgreSQL certification store");
    if(!this.settings.allowedChecks.includes(input.checkId))throw new MissionConflictError("Check is outside trusted operator policy");
    const record=await this.store.getMission(input.missionId),slice=record?.slices.find(x=>x.id===input.sliceId);
    if(!record||!slice||!record.plan?.approvedAt)throw new MissionConflictError("Mission slice is not ready for trusted verification");
    if(input.purpose==="final"&& (slice.status!=="awaiting_verification"||!slice.candidateSha||!slice.checks.includes(input.checkId)))throw new MissionConflictError("Mission slice is not ready for final trusted verification");
    if(input.purpose==="recovery"&&(slice.status!=="running"||slice.leaseEpoch!==input.epoch||!slice.checks.includes(input.strategyId)||!/^[a-f0-9]{40}$/i.test(input.candidateSha)))throw new MissionConflictError("Mission slice is not ready for recovery trusted verification");
    if(input.purpose==="recovery")await this.store.recoveryPolicyLease(input.missionId,input.sliceId,input.epoch,input.leaseToken,input.capabilityToken);
    let bundle:{digest:string;manifest:Buffer;files:Map<string,Buffer>};
    const candidateSha=input.purpose==="final"?slice.candidateSha!:input.candidateSha;
    try{bundle=await this.runner.prepareBundle(record.mission.repository,record.mission.baseSha,candidateSha);}catch{if(input.purpose==="final")await this.store.recordVerificationUnavailable?.(input.missionId,input.sliceId,slice.leaseEpoch,input.checkId,"candidate_unavailable");throw new MissionConflictError("Trusted candidate bundle is unavailable; verification is UNKNOWN");}
    let head:{sha:string;observedAt:string;digest:string};
    try{head=await this.runner.observeHead(record.mission.repository);}catch{if(input.purpose==="final")await this.store.recordVerificationUnavailable?.(input.missionId,input.sliceId,slice.leaseEpoch,input.checkId,"local_head_unavailable");throw new MissionConflictError("Trusted local head is unavailable; verification is UNKNOWN");}
    if(head.sha!==candidateSha||!/^[a-f0-9]{64}$/.test(bundle.digest)||!/^[a-f0-9]{64}$/.test(head.digest)){if(input.purpose==="final")await this.store.recordVerificationUnavailable?.(input.missionId,input.sliceId,slice.leaseEpoch,input.checkId,"local_head_unavailable");throw new MissionConflictError("Trusted candidate or local head binding failed; verification is UNKNOWN");}
    const now=this.clock(),expires=new Date(now.getTime()+this.settings.attemptLifetimeMs),attemptId=randomUUID();
    const request=parseTrustedCheckRequestV1({version:"orloom.trusted-check-request.v1",attemptId,missionId:input.missionId,sliceId:input.sliceId,leaseEpoch:slice.leaseEpoch,repository:record.mission.repository,candidateSha,expectedLocalHeadSha:head.sha,planDigest:createHash("sha256").update(canonicalJson(record.plan.slices)).digest("hex"),checkId:input.checkId,policyVersion:this.settings.policyVersion,policyDigest:this.settings.policyDigest,verifierImageDigest:this.settings.imageDigest,inputBundleDigest:bundle.digest,requestedAt:now.toISOString(),expiresAt:expires.toISOString()});
    const capability=randomBytes(32).toString("base64url");
    const binding={request,capabilityHash:createHash("sha256").update(capability).digest("hex"),capabilityExpiresAt:new Date(expires.getTime()+120_000).toISOString(),leasePolicyDigest:this.settings.leasePolicyDigest,headObservedAt:head.observedAt,headObservationDigest:head.digest};
    if(input.purpose==="final")await this.store.createVerificationAttempt(binding);else{if(!this.store.createRecoveryAttempt)throw new MissionConflictError("Trusted recovery attempts are unavailable in this store");await this.store.createRecoveryAttempt({...binding,purpose:"recovery",recoveryOrdinal:input.ordinal,targetCheckId:input.targetCheckId,strategyId:input.strategyId,recoveryPolicyDigest:input.recoveryPolicyDigest},input.leaseToken,input.capabilityToken);}
    this.pending.set(attemptId,{capability,bundle});return request;
  }
  async run(value:TrustedCheckRequestV1):Promise<TrustedCheckReceiptV1>{
    const request=parseTrustedCheckRequestV1(value),pending=this.pending.get(request.attemptId);
    if(!pending)throw new MissionConflictError("Trusted verifier attempt is unavailable after process restart");
    try{return await this.runner.run(request,pending.bundle);}catch{this.pending.delete(request.attemptId);throw new MissionConflictError("Trusted verifier did not produce a receipt; attempt will expire UNKNOWN");}
  }
  async submit(value:TrustedCheckReceiptV1,capability:string):Promise<CheckCertificateV1|null>{
    const receipt=value,request=parseTrustedCheckRequestV1(receipt.request),pending=this.pending.get(request.attemptId);
    if(!pending||!secretMatches(pending.capability,capability))throw new MissionConflictError("Verifier capability is invalid or expired");
    try{
      await this.runner.verifyArtifacts(receipt);const head=await this.runner.observeHead(request.repository);
      if(receipt.verifierId!==this.settings.verifierId||request.verifierImageDigest!==this.settings.imageDigest||request.policyDigest!==this.settings.policyDigest)throw new MissionConflictError("Trusted runner identity or policy binding changed");
      return await this.store.submitVerification!(receipt,createHash("sha256").update(capability).digest("hex"),head.sha,head.observedAt,head.digest,randomUUID());
    }finally{this.pending.delete(request.attemptId);}
  }
  async runRecoveryAttempt(input:{missionId:string;sliceId:string;epoch:number;leaseToken:string;capabilityToken:string;candidateSha:string;targetCheckId:string;strategyId:string;checkId:string;ordinal:number;recoveryPolicyDigest:string}){
    if(!this.store.createRecoveryAttempt||!this.store.submitRecoveryVerification)throw new MissionConflictError("Trusted recovery is disabled without the PostgreSQL attempt store");
    const request=await this.prepareShared({...input,purpose:"recovery"}),pending=this.pending.get(request.attemptId);
    if(!pending)throw new MissionConflictError("Trusted recovery capability was lost");
    let receipt:TrustedCheckReceiptV1;
    try{receipt=await this.runner.run(request,pending.bundle);}catch{this.pending.delete(request.attemptId);throw new MissionConflictError("Trusted recovery execution is unavailable; attempt remains UNKNOWN until expiry");}
    try{
      await this.runner.verifyArtifacts(receipt);const head=await this.runner.observeHead(request.repository);
      if(receipt.verifierId!==this.settings.verifierId||request.verifierImageDigest!==this.settings.imageDigest||request.policyDigest!==this.settings.policyDigest)throw new MissionConflictError("Trusted runner identity or policy binding changed");
      return await this.store.submitRecoveryVerification(receipt,createHash("sha256").update(pending.capability).digest("hex"),head.sha,head.observedAt,head.digest);
    }finally{this.pending.delete(request.attemptId);}
  }
  async challengerEvidence(attemptIds:string[]){
    if(!this.store.getTrustedAttempt||attemptIds.length!==4||new Set(attemptIds).size!==4)throw new MissionConflictError("Challenger evidence is unavailable or malformed");
    const evidence=[];
    for(const attemptId of attemptIds){const attempt=await this.store.getTrustedAttempt(attemptId);if(!attempt||attempt.purpose!=="recovery"||attempt.outcome===null||!attempt.receipt)throw new MissionConflictError("Challenge requires persisted terminal recovery attempts");const artifacts=await this.runner.verifyArtifacts(attempt.receipt);evidence.push({attempt,...artifacts});}
    return evidence;
  }
  async challengeLesson(lessonId:string){
    if(!this.store.lessonChallengeEvidence||!this.store.recordLessonChallenge)throw new MissionConflictError("Independent lesson challenge storage is unavailable");
    const candidate=await this.store.getLesson?.(lessonId);if(!candidate)throw new MissionConflictError("Lesson candidate is unavailable");
    const provenance={repository:candidate.repository,cohort:candidate.cohort,fromCheckId:candidate.fromCheckId,strategyId:candidate.strategyId,policyVersion:candidate.policyVersion,policyDigest:candidate.policyDigest,evidenceEventIds:candidate.evidenceEventIds,metric:candidate.metric,direction:candidate.direction,baseline:candidate.baseline,outcome:candidate.outcome};
    const persistRejected=async(evidence:unknown)=>{const rejected=rejectTrustedLessonReadback({verifierId:"controller:orloom.lesson-challenger.v1",provenance,evidence,reason:"persisted trusted receipt or artifact readback failed"});const attestationDigest=await this.store.recordLessonChallenge!({lessonId,lessonVersion:candidate.lessonVersion,candidateDigest:candidate.challengeDigest,challengeDigest:rejected.challengeDigest,evidenceDigest:rejected.evidenceDigest,verifierId:rejected.verifierId,algorithmVersion:rejected.algorithmVersion,decision:rejected.decision,reason:rejected.reason});return{...rejected,attestationDigest};};
    let source:Awaited<ReturnType<NonNullable<MissionStore["lessonChallengeEvidence"]>>>;
    try{source=await this.store.lessonChallengeEvidence(lessonId)??null;}catch{return persistRejected({lessonId,lessonVersion:candidate.lessonVersion,evidenceEventIds:candidate.evidenceEventIds});}
    if(!source)return persistRejected({lessonId,lessonVersion:candidate.lessonVersion,evidenceEventIds:candidate.evidenceEventIds,attempts:[]});
    const attempts:ChallengedAttempt[]=[];
    try{for(const item of source.attempts){if(!item.receipt||!item.receiptDigest||!item.outcome)return persistRejected({lessonId,lessonVersion:candidate.lessonVersion,eventId:item.eventId,attemptId:item.attemptId,receiptDigest:item.receiptDigest});const verified=await this.runner.verifyArtifacts(item.receipt);attempts.push({attemptId:item.attemptId,eventId:item.eventId,observation:item.observation,outcome:item.outcome,candidateSha:item.candidateSha,checkId:item.checkId,requestDigest:item.requestDigest,receiptDigest:item.receiptDigest,artifacts:[item.receipt.stdout,item.receipt.stderr,item.receipt.inputManifest].map(x=>({sha256:x.sha256,bytes:x.bytes})),request:item.receipt.request,receipt:item.receipt,stdout:verified.stdout,stderr:verified.stderr,manifest:verified.manifest});}}catch{return persistRejected({lessonId,lessonVersion:candidate.lessonVersion,attempts:source.attempts.map(item=>({eventId:item.eventId,attemptId:item.attemptId,requestDigest:item.requestDigest,receiptDigest:item.receiptDigest}))});}
    const lesson=source.lesson;
    const challenge=challengeTrustedLesson({verifierId:"controller:orloom.lesson-challenger.v1",provenance,attempts,expectedPolicyDigest:this.settings.leasePolicyDigest,expectedTrustedRunnerPolicyDigest:this.settings.policyDigest,expectedCheckIds:new Set(this.settings.allowedChecks)});
    const attestationDigest=await this.store.recordLessonChallenge({lessonId,lessonVersion:lesson.lessonVersion,candidateDigest:lesson.challengeDigest,challengeDigest:challenge.challengeDigest,evidenceDigest:challenge.evidenceDigest,verifierId:challenge.verifierId,algorithmVersion:challenge.algorithmVersion,decision:challenge.decision,reason:challenge.reason});
    return{...challenge,attestationDigest};
  }
  async verifySlice(missionId:string,sliceId:string){
    const record=await this.store.getMission(missionId),slice=record?.slices.find(x=>x.id===sliceId);if(!slice)return;
    for(const checkId of slice.checks.filter(id=>this.settings.allowedChecks.includes(id))){const request=await this.prepare(missionId,sliceId,checkId),receipt=await this.run(request),pending=this.pending.get(request.attemptId);if(!pending)throw new MissionConflictError("Trusted verifier capability was lost");await this.submit(receipt,pending.capability);}
  }
  async reconcile(limit=10){
    if(!this.store.awaitingVerification)return 0;
    const pending=await this.store.awaitingVerification(this.settings.allowedChecks,limit);
    for(const item of pending)await this.verifySlice(item.missionId,item.sliceId);
    return pending.length;
  }
  async getCertificate(missionId:string,sliceId:string,checkId:string){
    if(!this.store.getCertificate)return null;
    const certificate=await this.store.getCertificate(missionId,sliceId,checkId);if(!certificate)return null;
    const request=await this.store.getCertificateRequest?.(missionId,sliceId,checkId);if(!request||request.policyVersion!==this.settings.policyVersion||request.policyDigest!==this.settings.policyDigest||request.verifierImageDigest!==this.settings.imageDigest)return null;
    const record=await this.store.getMission(missionId),slice=record?.slices.find(x=>x.id===sliceId);
    if(!record||!slice||certificate.repository!==record.mission.repository||certificate.candidateSha!==slice.candidateSha||certificate.leaseEpoch!==slice.leaseEpoch||certificate.policyDigest!==this.settings.policyDigest)return null;
    const head=await this.runner.observeHead(record.mission.repository);return head.sha===certificate.localHeadSha?certificate:null;
  }
  expire(now=new Date(),limit=100){return this.store.expireVerificationAttempts?this.store.expireVerificationAttempts(now,limit):Promise.resolve(0);}
}

export interface GovernorConfig { maxLanes: number; capacitySlots: number; leaseSeconds: number; trustedCheckPolicyDigest: string | null; recoveryPolicyDigest?: string | null; trustedCheckPolicy?: string[]; trustedStrategies?: Record<string,TrustedStrategyPolicy>; executionConfigured?: boolean; progressLimits?: {maxProviderCalls:number;maxInputTokens:number;maxOutputTokens:number;maxWallSeconds:number}; }
export type RecoveryJudgmentAdapter=(snapshot:DecisionSnapshotV1)=>Promise<JudgmentV1>;
export interface SchedulingJudgmentResult { selectedCandidateId:string; modelId:string; tokenUsage:SchedulingTokenUsage; }
export type SchedulingJudgmentAdapter=(snapshot:SchedulingSnapshot,decisionId:string)=>Promise<SchedulingJudgmentResult>;
export interface IndependentReviewArtifactReader { read(artifactId:string):Promise<Buffer|null>; }
export interface LocalIntegrationAuthority { integrator:LocalIntegrator; reviews:IndependentReviewArtifactReader; }
function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function validateGovernorConfig(config: GovernorConfig) {
  if (!Number.isInteger(config.maxLanes) || config.maxLanes < 1 || config.maxLanes > 6 || !Number.isInteger(config.capacitySlots) || config.capacitySlots < 0 || config.capacitySlots > config.maxLanes || !Number.isInteger(config.leaseSeconds) || config.leaseSeconds < 30 || config.leaseSeconds > 3600) throw new Error("Invalid governor lane or lease configuration");
  return config;
}
export function makeMissionInput(input: MissionInput) { validateMission(input); return input; }
export function makePlan(missionId: string, slices: SliceInput[], recommendedBy: string) { validatePlan(missionId, slices, recommendedBy); return slices; }
export class MissionGovernor {
  constructor(private readonly store: MissionStore, private readonly config: GovernorConfig, private readonly judgmentAdapter?:RecoveryJudgmentAdapter, private readonly schedulingAdapter?:SchedulingJudgmentAdapter, private readonly learningActivation?:LearningActivation) {
    validateGovernorConfig(config);
  }
  submit(input: MissionInput) { validateMission(input); return this.store.submit(input); }
  recommend(missionId: string, slices: SliceInput[], recommendedBy: string) { validatePlan(missionId, slices, recommendedBy); const strategies=this.config.trustedStrategies??{};const allowed=new Set(Object.keys(strategies).length?Object.keys(strategies):(this.config.trustedCheckPolicy??[]));if(slices.some(s=>!s.checks.length||s.checks.some(c=>!allowed.has(c))))throw new MissionValidationError("slice checks must be selected from the trusted operator policy");return this.store.recommendPlan(missionId, slices, recommendedBy); }
  approve(missionId: string) { return this.store.approvePlan(missionId); }
  private integrationReviewMatches(raw:Buffer|null,request:IntegrationRequestV1,slice:MissionSlice,treeSha:string){
    if(!raw||createHash("sha256").update(raw).digest("hex")!==request.reviewArtifactDigest)return false;
    let review:unknown;try{review=JSON.parse(raw.toString("utf8"));}catch{return false;}
    const value=review as Record<string,unknown>,keys=["version","verdict","candidateSha","treeSha","reviewer","builder","scopes"];
    return Boolean(value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key))&&value.version==="orloom.independent-review.v1"&&value.verdict==="PASS"&&value.candidateSha===request.candidateSha&&value.treeSha===treeSha&&value.builder===slice.owner&&value.reviewer!==value.builder&&typeof value.reviewer==="string"&&value.reviewer.length>0&&Array.isArray(value.scopes)&&value.scopes.every(scope=>typeof scope==="string")&&canonicalJson([...(value.scopes as string[])].sort())===canonicalJson([...slice.scopes].sort()));
  }
  private async reconcileCompletedIntegration(request:IntegrationRequestV1,authority:LocalIntegrationAuthority):Promise<MissionSlice|null>{
    try{
      if(!this.store.getIntegrationIntent||!this.store.finishIntegrationIntent)return null;
      const intent=await this.store.getIntegrationIntent(request);
      if(!intent||intent.state!=="integrated"||intent.observedIntegrationSha!==request.candidateSha||!/^[a-f0-9]{40}$/.test(intent.treeSha)||intent.certificateIds.length!==request.requiredCheckIds.length||intent.certificateDigests.length!==request.requiredCheckIds.length||new Set(intent.certificateIds).size!==intent.certificateIds.length||intent.certificateDigests.some(digest=>!/^[a-f0-9]{64}$/.test(digest)))return null;
      const record=await this.store.getMission(request.missionId),slice=record?.slices.find(candidate=>candidate.id===request.sliceId),plan=record?.plan;
      if(!record||!slice||!plan?.approvedAt||slice.status!=="verified"||slice.missionId!==request.missionId||slice.leaseEpoch!==request.leaseEpoch||slice.candidateSha!==request.candidateSha||authority.integrator.repositoryIdentity!==record.mission.repository.toLowerCase()||canonicalJson([...slice.checks].sort())!==canonicalJson([...request.requiredCheckIds].sort())||!request.requiredCheckIds.includes("node-repo-suite-v1")||!this.config.trustedCheckPolicyDigest||!this.config.trustedCheckPolicy?.includes("node-repo-suite-v1")||request.requiredCheckIds.some(check=>!this.config.trustedCheckPolicy?.includes(check)))return null;
      const planDigest=createHash("sha256").update(canonicalJson(plan.slices)).digest("hex");
      const inspected=await authority.integrator.inspect({expectedRefSha:request.expectedIntegrationSha,candidateSha:request.candidateSha,scopes:slice.scopes});
      if(inspected.candidateSha!==request.candidateSha||inspected.treeSha!==intent.treeSha)return null;
      const review=await authority.reviews.read(request.reviewArtifactId);
      if(!this.integrationReviewMatches(review,request,slice,inspected.treeSha))return null;
      if(await authority.integrator.readRef()!==request.candidateSha)return null;
      const replay=await this.store.finishIntegrationIntent(request,request.candidateSha,inspected.treeSha,{planDigest,policyDigest:this.config.trustedCheckPolicyDigest});
      return replay.status==="verified"&&replay.missionId===request.missionId&&replay.id===request.sliceId&&replay.leaseEpoch===request.leaseEpoch&&replay.candidateSha===request.candidateSha?replay:null;
    }catch{return null;}
  }
  async integrateVerifiedSlice(input:IntegrationRequestV1,trustedChecks:TrustedCheckCoordinator|null|undefined,authority:LocalIntegrationAuthority|null|undefined){
    if(!authority||!trustedChecks||!this.store.createIntegrationIntent||!this.store.finishIntegrationIntent||!this.store.markIntegrationUnknown||!this.store.getTrustedAttempt||!this.store.getCertificate)throw new MissionConflictError("Local integration remains closed without controller-owned Git, review, and trusted certificate services");
    const keys=["version","missionId","sliceId","expectedIntegrationSha","candidateSha","leaseEpoch","requiredCheckIds","reviewArtifactId","reviewArtifactDigest"];
    if(!input||Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k))||input.version!=="orloom.integration-request.v1"||! /^[a-f0-9]{40}$/.test(input.expectedIntegrationSha)||! /^[a-f0-9]{40}$/.test(input.candidateSha)||!Number.isSafeInteger(input.leaseEpoch)||input.leaseEpoch<1||! /^[a-f0-9]{64}$/.test(input.reviewArtifactDigest)||! /^[A-Za-z0-9._:-]{1,180}$/.test(input.reviewArtifactId)||!Array.isArray(input.requiredCheckIds)||!input.requiredCheckIds.length||input.requiredCheckIds.some(x=>typeof x!=="string")||new Set(input.requiredCheckIds).size!==input.requiredCheckIds.length)throw new MissionValidationError("Invalid exact local integration request");
    const req={...input,requiredCheckIds:[...input.requiredCheckIds].sort()};const existing=await this.store.getIntegrationIntent?.(req);
    if(existing?.state==="unknown")throw new MissionConflictError("Integration intent is UNKNOWN and must not be retried");
    if(existing?.state==="integrated"){
      const replay=await this.reconcileCompletedIntegration(req,authority);
      if(replay)return replay;
      throw new MissionConflictError("Completed integration no longer satisfies the exact replay fences");
    }
    if(existing){let current:string|null;try{current=await authority.integrator.readRef();}catch{await this.store.markIntegrationUnknown(req,null,"pending_intent_ref_unavailable");throw new MissionConflictError("Pending integration ref is unavailable; intent is UNKNOWN");}if(current!==req.expectedIntegrationSha&&current!==req.candidateSha){await this.store.markIntegrationUnknown(req,current,"pending_intent_ref_moved");throw new MissionConflictError("Pending integration intent observed an unexpected ref and is now UNKNOWN");}}
    const record=await this.store.getMission(input.missionId),slice=record?.slices.find(x=>x.id===input.sliceId),plan=record?.plan;
    if(!record||!slice||!plan?.approvedAt||slice.status!=="awaiting_verification"||slice.leaseEpoch!==input.leaseEpoch||slice.candidateSha!==input.candidateSha||canonicalJson([...input.requiredCheckIds].sort())!==canonicalJson([...slice.checks].sort())||slice.dependencies.length&&(await Promise.all(slice.dependencies.map(async id=>(await this.store.getMission(input.missionId))?.slices.find(x=>x.id===id)?.status))).some(status=>status!=="verified")){
      const replay=await this.reconcileCompletedIntegration(req,authority);
      if(replay)return replay;
      throw new MissionConflictError("Integration does not match the approved, awaiting candidate");
    }
    if(authority.integrator.repositoryIdentity!==record.mission.repository.toLowerCase())throw new MissionConflictError("Fixed local Git integrator is not authorized for this mission repository");
    if(!this.config.trustedCheckPolicyDigest)throw new MissionConflictError("Trusted check policy is not configured");
    if(!input.requiredCheckIds.includes("node-repo-suite-v1")||!this.config.trustedCheckPolicy?.includes("node-repo-suite-v1"))throw new MissionConflictError("Integration requires the mandatory trusted full repository-suite check");
    const inspected=await authority.integrator.inspect({expectedRefSha:input.expectedIntegrationSha,candidateSha:input.candidateSha,scopes:slice.scopes});
    const raw=await authority.reviews.read(input.reviewArtifactId);if(!this.integrationReviewMatches(raw,req,slice,inspected.treeSha))throw new MissionConflictError("Independent review does not bind this candidate, tree, reviewer, and exact scope");
    const planDigest=createHash("sha256").update(canonicalJson(plan.slices)).digest("hex");
    const certs=[] as CheckCertificateV1[],certDigests:string[]=[];
    for(const checkId of input.requiredCheckIds){
      let cert:CheckCertificateV1|null=null;try{cert=await trustedChecks.getCertificate(input.missionId,input.sliceId,checkId);}catch{/* A completed replay may have won between the read and the certificate lookup. */}
      if(!cert||cert.scope!=="local-exact-commit"||cert.candidateSha!==input.candidateSha||cert.localHeadSha!==input.candidateSha||cert.leaseEpoch!==input.leaseEpoch||cert.repository!==record.mission.repository||cert.planDigest!==planDigest||cert.policyDigest!==this.config.trustedCheckPolicyDigest){const replay=await this.reconcileCompletedIntegration(req,authority);if(replay)return replay;throw new MissionConflictError("A required final trusted certificate is missing or stale");}
      const attempt=await this.store.getTrustedAttempt(cert.attemptId);if(!attempt||attempt.purpose!=="final"||attempt.outcome!=="pass"||!attempt.receipt||attempt.receipt.receiptDigest!==cert.receiptDigest||attempt.request.candidateSha!==input.candidateSha||attempt.request.leaseEpoch!==input.leaseEpoch||attempt.request.checkId!==checkId)throw new MissionConflictError("Trusted certificate lacks matching persisted final PASS receipt");
      certs.push(cert);certDigests.push(createHash("sha256").update(canonicalJson(cert)).digest("hex"));
    }
    const intent=await this.store.createIntegrationIntent(req,inspected.treeSha,certs.map(c=>c.certificateId),certDigests,{planDigest,policyDigest:this.config.trustedCheckPolicyDigest});if(intent.state==="unknown")throw new MissionConflictError("Integration intent is UNKNOWN and must not be retried");
    let observed:string|null;try{observed=await authority.integrator.readRef();}catch{await this.store.markIntegrationUnknown(req,null,"integration_ref_unavailable");throw new MissionConflictError("Integration ref is unavailable; intent is UNKNOWN");}if(observed===req.expectedIntegrationSha){try{await authority.integrator.compareAndSwap({expectedRefSha:req.expectedIntegrationSha,candidateSha:req.candidateSha,scopes:slice.scopes});}catch{try{observed=await authority.integrator.readRef();}catch{observed=null;}if(observed!==req.candidateSha)await this.store.markIntegrationUnknown(req,observed,"compare_and_swap_ambiguous");if(observed!==req.candidateSha)throw new MissionConflictError("Integration compare-and-swap is ambiguous; intent is UNKNOWN");}}else if(observed!==req.candidateSha){await this.store.markIntegrationUnknown(req,observed,"integration_ref_moved");throw new MissionConflictError("Integration ref changed unexpectedly; intent is UNKNOWN");}
    try{observed=await authority.integrator.readRef();}catch{await this.store.markIntegrationUnknown(req,null,"compare_and_swap_readback_unavailable");throw new MissionConflictError("Integration ref readback is unavailable; intent is UNKNOWN");}if(observed!==req.candidateSha){await this.store.markIntegrationUnknown(req,observed,"compare_and_swap_not_observed");throw new MissionConflictError("Integration ref outcome is ambiguous; intent is UNKNOWN");}
    const finalReview=await authority.reviews.read(req.reviewArtifactId);if(!finalReview||createHash("sha256").update(finalReview).digest("hex")!==req.reviewArtifactDigest)throw new MissionConflictError("Retained review changed after Git compare-and-swap; durable intent remains pending");
    for(let i=0;i<req.requiredCheckIds.length;i++){
      let cert:CheckCertificateV1|null=null;try{cert=await trustedChecks.getCertificate(req.missionId,req.sliceId,req.requiredCheckIds[i]!);}catch{/* A concurrent finalizer may have moved the slice to verified. */}
      if(!cert||cert.certificateId!==intent.certificateIds[i]||createHash("sha256").update(canonicalJson(cert)).digest("hex")!==intent.certificateDigests[i]){const replay=await this.reconcileCompletedIntegration(req,authority);if(replay)return replay;throw new MissionConflictError("Trusted final certificate readback changed; durable intent remains pending");}
    }
    let finalRef:string|null;try{finalRef=await authority.integrator.readRef();}catch{await this.store.markIntegrationUnknown(req,null,"final_integration_ref_unavailable");throw new MissionConflictError("Integration ref became unavailable during final readback; intent is UNKNOWN");}if(finalRef!==req.candidateSha){await this.store.markIntegrationUnknown(req,finalRef,"final_integration_ref_moved");throw new MissionConflictError("Integration ref moved during final trusted readback; intent is UNKNOWN");}
    try{return await this.store.finishIntegrationIntent(req,observed,inspected.treeSha,{planDigest,policyDigest:this.config.trustedCheckPolicyDigest});}
    catch(error){const replay=await this.reconcileCompletedIntegration(req,authority);if(replay)return replay;throw error;}
  }
  async claim() {
    if (!this.config.capacitySlots || !this.config.trustedCheckPolicyDigest || !this.config.executionConfigured) return null;
    const recoveryPolicyDigest=this.config.recoveryPolicyDigest??"";let advice:ClaimAdvice|undefined,decision:{missionId:string;record:SchedulingDecisionRecord}|undefined;
    if(this.store.schedulingSnapshot){
      const snapshot=await this.store.schedulingSnapshot(this.config.trustedCheckPolicyDigest,recoveryPolicyDigest);
      if(this.schedulingAdapter&&snapshot.freeCapacity>0&&snapshot.choices.length>=2){
        const bounded={...snapshot,choices:rankSchedulingChoices(snapshot.choices).slice(0,32)};
        const snapshotDigest=schedulingSnapshotDigest({freeCapacity:bounded.freeCapacity,choices:bounded.choices}),decisionId=randomUUID(),anchor=bounded.choices[0]!;
        const record=async(phase:SchedulingDecisionRecord["phase"],status:SchedulingDecisionRecord["status"],selectedCandidateId:string|null,modelId:string|null,tokenUsage:SchedulingTokenUsage|null,tokenUsageStatus:SchedulingDecisionRecord["tokenUsageStatus"])=>(this.store.recordSchedulingDecision?.(anchor.missionId,{decisionId,phase,status,snapshotDigest,trustedCheckPolicyDigest:this.config.trustedCheckPolicyDigest!,recoveryPolicyDigest,dispatchMayHaveOccurred:true,preferredCandidateId:selectedCandidateId,validatedCandidateId:status==="selected"?selectedCandidateId:null,modelId,tokenUsage,tokenUsageStatus}));
        let canDispatch=false;
        try{if(this.store.recordSchedulingDecision){await record("dispatch_possible","pending",null,null,null,"unknown");canDispatch=true;}}catch{/* A possible Jev call must have a durable pre-dispatch record. */}
        if(canDispatch){
          let status:ClaimAdvice["status"]="unknown",preferredCandidateId:string|null=null,modelId:string|null=null,tokenUsage:SchedulingTokenUsage|null=null,tokenUsageStatus:SchedulingDecisionRecord["tokenUsageStatus"]="unknown";
          try{
            const result=await this.schedulingAdapter(bounded,decisionId),validModel=typeof result?.modelId==="string"&&result.modelId.length<=256&&/^[A-Za-z0-9._:-]+$/.test(result.modelId),validUsage=!!result?.tokenUsage&&Number.isSafeInteger(result.tokenUsage.inputTokens)&&result.tokenUsage.inputTokens>=0&&Number.isSafeInteger(result.tokenUsage.outputTokens)&&result.tokenUsage.outputTokens>=0;
            if(validModel)modelId=result.modelId;if(validUsage){tokenUsage={inputTokens:result.tokenUsage.inputTokens,outputTokens:result.tokenUsage.outputTokens};tokenUsageStatus="measured";}
            if(typeof result?.selectedCandidateId==="string"&&bounded.choices.some(x=>`${x.missionId}:${x.sliceId}`===result.selectedCandidateId)){status="selected";preferredCandidateId=result.selectedCandidateId;}else status="invalid";
          }catch{status="unknown";}
          try{await record("advice_resolved",status,preferredCandidateId,modelId,tokenUsage,tokenUsageStatus);}catch{status="unknown";preferredCandidateId=null;modelId=null;tokenUsage=null;tokenUsageStatus="unknown";}
          advice={decisionId,snapshotDigest,trustedCheckPolicyDigest:this.config.trustedCheckPolicyDigest,recoveryPolicyDigest,status,dispatchMayHaveOccurred:true,preferredCandidateId,validatedCandidateId:status==="selected"?preferredCandidateId:null,modelId,tokenUsage,tokenUsageStatus};
          decision={missionId:anchor.missionId,record:{decisionId,phase:"no_lease",status:"no_lease",snapshotDigest,trustedCheckPolicyDigest:this.config.trustedCheckPolicyDigest,recoveryPolicyDigest,dispatchMayHaveOccurred:true,preferredCandidateId,validatedCandidateId:null,modelId,tokenUsage,tokenUsageStatus}};
        }
      }
    }
    const grant=await this.store.claim(this.config.leaseSeconds,this.config.trustedCheckPolicyDigest,undefined,recoveryPolicyDigest,advice);
    if(!grant&&decision)await this.store.recordSchedulingDecision?.(decision.missionId,decision.record);
    return grant;
  }
  heartbeat(missionId:string,id: string, epoch: number, token: string, capability: string) { return this.store.heartbeat(missionId,id, epoch, token, capability, this.config.leaseSeconds); }
  complete(missionId:string,id: string, epoch: number, token: string, capability: string, candidateSha: string, evidenceRefs: string[]) {
    if (!/^[0-9a-f]{40}$/i.test(candidateSha) || !Array.isArray(evidenceRefs) || evidenceRefs.length > 100 || evidenceRefs.some(x => typeof x !== "string" || !x || x.length > 2048)) throw new Error("Invalid candidate result");
    return this.store.complete(missionId,id, epoch, token, capability, candidateSha, evidenceRefs);
  }
  async runTrustedRecoveryAttempt(coordinator:TrustedCheckCoordinator,input:{missionId:string;sliceId:string;epoch:number;leaseToken:string;capabilityToken:string;candidateSha:string;targetCheckId:string;strategyId:string;ordinal:number}){
    const strategy=this.config.trustedStrategies?.[input.strategyId];
    if(!strategy||!this.config.trustedCheckPolicy?.includes(strategy.checkId)||!this.config.trustedCheckPolicy.includes(input.targetCheckId)||!strategy.targetCheckIds.includes(input.targetCheckId)||!this.config.recoveryPolicyDigest||!Number.isSafeInteger(input.ordinal)||input.ordinal<1)throw new MissionValidationError("recovery attempt is outside the trusted strategy policy");
    return coordinator.runRecoveryAttempt({...input,checkId:strategy.checkId,recoveryPolicyDigest:this.config.recoveryPolicyDigest});
  }
  reportOutcome(missionId:string,id:string,epoch:number,token:string,capability:string,outcome:"BLOCKED"|"UNKNOWN",reasonCode:string,evidenceRefs:string[]){
    const allowed=new Set(["dependency_missing","provider_unavailable","budget_exhausted","scope_conflict","other"]);
    if(!allowed.has(reasonCode)||!Array.isArray(evidenceRefs)||evidenceRefs.length>100||evidenceRefs.some(x=>typeof x!=="string"||!x||x.length>2048))throw new MissionValidationError("invalid worker outcome");
    return this.store.reportOutcome(missionId,id,epoch,token,capability,outcome,reasonCode,evidenceRefs);
  }
  async recordProgress(progress: RecoveryProgress, leaseToken: string, capabilityToken: string): Promise<ProgressReceipt> {
    const progressFields = [
      "version", "eventId", "missionId", "sliceId", "leaseEpoch", "ordinal", "planDigest",
      "trustedCheckPolicyDigest", "recoveryPolicyDigest", "phase", "status", "reasonCode",
      "strategyId", "targetCheckId", "checkId", "counters", "evidenceRefs",
      ...(progress?.version==="orloom.progress.v2"?["trustedAttemptId","candidateSha"]:[]),
    ];
    const counterFields = ["providerCalls", "inputTokens", "outputTokens", "wallMs"];
    const limits = this.config.progressLimits ?? { maxProviderCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxWallSeconds: 0 };
    const validCounters = exactKeys(progress?.counters, counterFields)
      && [progress.counters.providerCalls, progress.counters.inputTokens, progress.counters.outputTokens, progress.counters.wallMs]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
      && progress.counters.providerCalls <= limits.maxProviderCalls
      && progress.counters.inputTokens <= limits.maxInputTokens
      && progress.counters.outputTokens <= limits.maxOutputTokens
      && progress.counters.wallMs <= limits.maxWallSeconds * 1000;
    if (!exactKeys(progress, progressFields) || !validCounters
      || !(progress.version === "orloom.progress.v1" || progress.version === "orloom.progress.v2")
      || !/^[-a-zA-Z0-9_.:]{1,128}$/.test(progress.eventId)
      || !/^[-a-zA-Z0-9_]{1,64}$/.test(progress.missionId)
      || !/^[-a-zA-Z0-9_]{1,64}$/.test(progress.sliceId)
      || !Number.isSafeInteger(progress.leaseEpoch) || progress.leaseEpoch < 1
      || !Number.isSafeInteger(progress.ordinal) || progress.ordinal < 1
      || !/^[a-f0-9]{64}$/.test(progress.planDigest)
      || !/^[a-f0-9]{64}$/.test(progress.trustedCheckPolicyDigest)
      || !/^[a-f0-9]{64}$/.test(progress.recoveryPolicyDigest)
      || progress.phase !== "trusted_check"
      || !["started", "passed", "failed", "blocked", "unknown"].includes(progress.status)
      || !["check_failed", "check_passed", "provider_unavailable", "budget_exhausted", "scope_conflict", "other"].includes(progress.reasonCode)
      || !/^[-a-zA-Z0-9_.:]{1,128}$/.test(progress.strategyId)
      || typeof progress.targetCheckId !== "string" || progress.targetCheckId.length > 1000 || /[\x00-\x1f]/.test(progress.targetCheckId)
      || typeof progress.checkId !== "string" || progress.checkId.length > 1000 || /[\x00-\x1f]/.test(progress.checkId)
      || !Array.isArray(progress.evidenceRefs) || progress.evidenceRefs.length > 20
      || progress.evidenceRefs.some((ref) => typeof ref !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref))) {
      throw new MissionValidationError("invalid typed recovery progress");
    }
    if ((progress.status==="failed"||progress.status==="passed")&&progress.version!=="orloom.progress.v2")throw new MissionValidationError("terminal recovery progress requires a trusted attempt");
    if(progress.version==="orloom.progress.v2"&&(!/^[0-9a-f-]{36}$/i.test(progress.trustedAttemptId)||!/^[a-f0-9]{40}$/.test(progress.candidateSha)))throw new MissionValidationError("invalid trusted recovery attempt binding");
    if ((progress.status === "failed" && progress.reasonCode !== "check_failed")
      || (progress.status === "passed" && progress.reasonCode !== "check_passed")) {
      throw new MissionValidationError("progress reason does not match its status");
    }

    const strategy = this.config.trustedStrategies?.[progress.strategyId];
    const mission = await this.store.getMission(progress.missionId);
    const slice = mission?.slices.find((candidate) => candidate.id === progress.sliceId);
    const cohort = slice?.scopes.slice().sort()[0]?.split("/")[0]?.toLowerCase();
    if (!strategy || !this.config.recoveryPolicyDigest
      || progress.recoveryPolicyDigest !== this.config.recoveryPolicyDigest
      || strategy.checkId !== progress.checkId
      || !strategy.targetCheckIds.includes(progress.targetCheckId)
      || !this.config.trustedCheckPolicy?.includes(progress.targetCheckId)
      || (!strategy.scopeClasses.includes("*") && !strategy.scopeClasses.includes(cohort ?? ""))) {
      throw new MissionValidationError("progress is outside the trusted strategy policy");
    }
    return this.store.recordProgress(progress, leaseToken, capabilityToken, this.config.trustedStrategies ?? {}, this.judgmentAdapter);
  }  lessons(missionId:string):Promise<LessonCandidate[]>{return this.store.lessons(missionId);}
  async promoteLesson(id:string,challengeDigest:string){
    if(!this.learningActivation)throw new MissionConflictError("Learning runtime acceptance is unavailable; promotion remains disabled");
    try{await this.learningActivation.assertAccepted();}catch{throw new MissionConflictError("Learning runtime acceptance is unavailable; promotion remains disabled");}
    if(!/^[a-f0-9]{64}$/.test(challengeDigest))throw new MissionValidationError("invalid lesson challenge digest");
    const lesson=await this.store.getLesson?.(id);const strategy=lesson&&this.config.trustedStrategies?.[lesson.strategyId];
    if(!lesson||lesson.status==="withdrawn"||!strategy||strategy.version!==lesson.policyVersion||!strategy.targetCheckIds.includes(lesson.fromCheckId)||!this.config.recoveryPolicyDigest||lesson.policyDigest!==this.config.recoveryPolicyDigest)throw new MissionConflictError("Lesson is outside the current Governor policy");
    return this.store.promoteLesson(id,challengeDigest,"controller:lesson-governor");
  }
  async recoveryPolicy(missionId:string,sliceId:string,epoch:number,leaseToken:string,capabilityToken:string){const binding=await this.store.recoveryPolicyLease(missionId,sliceId,epoch,leaseToken,capabilityToken);const mission=await this.store.getMission(missionId),slice=mission?.slices.find(x=>x.id===sliceId);if(!slice)throw new MissionConflictError("Slice unavailable");const cohort=slice.scopes.slice().sort()[0]?.split("/")[0]?.toLowerCase();const strategies=Object.fromEntries(slice.checks.filter(id=>{const p=this.config.trustedStrategies?.[id];return p&&p.targetCheckIds.length&&p.scopeClasses.some(x=>x==="*"||x===cohort);}).map(id=>[id,this.config.trustedStrategies![id]!]));return{version:"orloom.recovery-policy.v1",missionId,sliceId,leaseEpoch:epoch,...binding,strategies};}
  get(id: string) { return this.store.getMission(id); }
  events(id: string, cursor: number) { return this.store.events(id, cursor); }
  expire() { return this.store.expire(); }
  configureCapacity(count:number,digest:string|null,expires:string|null){return this.store.configureCapacity(count,digest,expires);}
}
export function newMissionId() { return randomUUID(); }
export function newSecret() { return randomBytes(32).toString("base64url"); }
export function secretMatches(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export type { Mission, MissionPlan, MissionSlice, MissionStore };
