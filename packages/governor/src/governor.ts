import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DecisionSnapshotV1, JudgmentV1 } from "../../judgment/src/types.js";
import { Lane, LessonCandidate, LessonValidationChallenge, Mission, MissionConflictError, MissionInput, MissionPlan, MissionSlice, MissionStore, MissionValidationError, ProgressReceipt, ProgressV1, RecoveryAttemptBinding, RecoveryProgress, SliceInput, TrustedStrategyPolicy, validateMission, validatePlan } from "../../contracts/src/mission.js";
import { CheckCertificateV1, parseTrustedCheckRequestV1, TRUSTED_CHECK_LIMITS, TrustedCheckReceiptV1, TrustedCheckRequestV1, TrustedCheckService } from "../../contracts/src/verification.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import type { LearningActivation } from "../../learning/src/activation.js";
import { challengeTrustedLesson, rejectTrustedLessonReadback, type ChallengedAttempt } from "../../learning/src/challenger.js";

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
  constructor(private readonly store: MissionStore, private readonly config: GovernorConfig, private readonly judgmentAdapter?:RecoveryJudgmentAdapter, private readonly learningActivation?:LearningActivation) {
    validateGovernorConfig(config);
  }
  submit(input: MissionInput) { validateMission(input); return this.store.submit(input); }
  recommend(missionId: string, slices: SliceInput[], recommendedBy: string) { validatePlan(missionId, slices, recommendedBy); const strategies=this.config.trustedStrategies??{};const allowed=new Set(Object.keys(strategies).length?Object.keys(strategies):(this.config.trustedCheckPolicy??[]));if(slices.some(s=>!s.checks.length||s.checks.some(c=>!allowed.has(c))))throw new MissionValidationError("slice checks must be selected from the trusted operator policy");return this.store.recommendPlan(missionId, slices, recommendedBy); }
  approve(missionId: string) { return this.store.approvePlan(missionId); }
  claim() { if (!this.config.capacitySlots || !this.config.trustedCheckPolicyDigest || !this.config.executionConfigured) return Promise.resolve(null); return this.store.claim(this.config.leaseSeconds, this.config.trustedCheckPolicyDigest,undefined,this.config.recoveryPolicyDigest??""); }
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
