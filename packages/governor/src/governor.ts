import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DecisionSnapshotV1, JudgmentV1 } from "../../judgment/src/types.js";
import { Lane, LessonCandidate, LessonValidationChallenge, Mission, MissionConflictError, MissionInput, MissionPlan, MissionSlice, MissionStore, MissionValidationError, ProgressReceipt, ProgressV1, SliceInput, TrustedStrategyPolicy, validateMission, validatePlan } from "../../contracts/src/mission.js";
import { CheckCertificateV1, parseTrustedCheckRequestV1, TRUSTED_CHECK_LIMITS, TrustedCheckReceiptV1, TrustedCheckRequestV1, TrustedCheckService } from "../../contracts/src/verification.js";
import { canonicalJson } from "../../judgment/src/canonical.js";

export interface TrustedCheckRunner {
  prepareBundle(repository:string,baseSha:string,candidateSha:string):Promise<{digest:string;manifest:Buffer;files:Map<string,Buffer>}>;
  observeHead(repository:string):Promise<{sha:string;observedAt:string;digest:string}>;
  run(request:TrustedCheckRequestV1,bundle:{digest:string;manifest:Buffer;files:Map<string,Buffer>}):Promise<TrustedCheckReceiptV1>;
  verifyArtifacts(receipt:TrustedCheckReceiptV1):Promise<unknown>;
}
export class TrustedCheckCoordinator implements TrustedCheckService {
  private readonly pending=new Map<string,{capability:string;bundle:{digest:string;manifest:Buffer;files:Map<string,Buffer>}}>();
  constructor(private readonly store:MissionStore,private readonly runner:TrustedCheckRunner,private readonly settings:{imageDigest:string;verifierId:string;policyDigest:string;leasePolicyDigest:string;policyVersion:string;allowedChecks:string[];attemptLifetimeMs:number},private readonly clock=()=>new Date()){
    if(!Number.isSafeInteger(settings.attemptLifetimeMs)||settings.attemptLifetimeMs<1||settings.attemptLifetimeMs>TRUSTED_CHECK_LIMITS.maxLifetimeMs)throw new Error("trusted check attempt lifetime is outside contract bounds");
  }
  async prepare(missionId:string,sliceId:string,checkId:string):Promise<TrustedCheckRequestV1>{
    if(!this.store.createVerificationAttempt||!this.store.submitVerification)throw new MissionConflictError("Trusted verification is disabled without the PostgreSQL certification store");
    if(!this.settings.allowedChecks.includes(checkId))throw new MissionConflictError("Check is outside trusted operator policy");
    const record=await this.store.getMission(missionId),slice=record?.slices.find(x=>x.id===sliceId);
    if(!record||!slice||slice.status!=="awaiting_verification"||!slice.candidateSha||!slice.checks.includes(checkId)||!record.plan?.approvedAt)throw new MissionConflictError("Mission slice is not ready for trusted verification");
    let bundle:{digest:string;manifest:Buffer;files:Map<string,Buffer>};
    try{bundle=await this.runner.prepareBundle(record.mission.repository,record.mission.baseSha,slice.candidateSha);}catch{await this.store.recordVerificationUnavailable?.(missionId,sliceId,slice.leaseEpoch,checkId,"candidate_unavailable");throw new MissionConflictError("Trusted candidate bundle is unavailable; verification is UNKNOWN");}
    let head:{sha:string;observedAt:string;digest:string};
    try{head=await this.runner.observeHead(record.mission.repository);}catch{await this.store.recordVerificationUnavailable?.(missionId,sliceId,slice.leaseEpoch,checkId,"local_head_unavailable");throw new MissionConflictError("Trusted local head is unavailable; verification is UNKNOWN");}
    if(head.sha!==slice.candidateSha||!/^[a-f0-9]{64}$/.test(bundle.digest)||!/^[a-f0-9]{64}$/.test(head.digest)){await this.store.recordVerificationUnavailable?.(missionId,sliceId,slice.leaseEpoch,checkId,"local_head_unavailable");throw new MissionConflictError("Trusted candidate or local head binding failed; verification is UNKNOWN");}
    const now=this.clock(),expires=new Date(now.getTime()+this.settings.attemptLifetimeMs),attemptId=randomUUID();
    const request=parseTrustedCheckRequestV1({version:"orloom.trusted-check-request.v1",attemptId,missionId,sliceId,leaseEpoch:slice.leaseEpoch,repository:record.mission.repository,candidateSha:slice.candidateSha,expectedLocalHeadSha:head.sha,planDigest:createHash("sha256").update(canonicalJson(record.plan.slices)).digest("hex"),checkId,policyVersion:this.settings.policyVersion,policyDigest:this.settings.policyDigest,verifierImageDigest:this.settings.imageDigest,inputBundleDigest:bundle.digest,requestedAt:now.toISOString(),expiresAt:expires.toISOString()});
    const capability=randomBytes(32).toString("base64url");
    await this.store.createVerificationAttempt({request,capabilityHash:createHash("sha256").update(capability).digest("hex"),capabilityExpiresAt:new Date(expires.getTime()+120_000).toISOString(),leasePolicyDigest:this.settings.leasePolicyDigest,headObservedAt:head.observedAt,headObservationDigest:head.digest});
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
  constructor(private readonly store: MissionStore, private readonly config: GovernorConfig, private readonly judgmentAdapter?:RecoveryJudgmentAdapter) {
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
  reportOutcome(missionId:string,id:string,epoch:number,token:string,capability:string,outcome:"BLOCKED"|"UNKNOWN",reasonCode:string,evidenceRefs:string[]){
    const allowed=new Set(["dependency_missing","provider_unavailable","budget_exhausted","scope_conflict","other"]);
    if(!allowed.has(reasonCode)||!Array.isArray(evidenceRefs)||evidenceRefs.length>100||evidenceRefs.some(x=>typeof x!=="string"||!x||x.length>2048))throw new MissionValidationError("invalid worker outcome");
    return this.store.reportOutcome(missionId,id,epoch,token,capability,outcome,reasonCode,evidenceRefs);
  }
  async recordProgress(progress: ProgressV1, leaseToken: string, capabilityToken: string): Promise<ProgressReceipt> {
    const progressFields = [
      "version", "eventId", "missionId", "sliceId", "leaseEpoch", "ordinal", "planDigest",
      "trustedCheckPolicyDigest", "recoveryPolicyDigest", "phase", "status", "reasonCode",
      "strategyId", "targetCheckId", "checkId", "counters", "evidenceRefs",
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
      || progress.version !== "orloom.progress.v1"
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
  promoteLesson(_id:string,_challenge:LessonValidationChallenge):never {
    throw new MissionConflictError("Independent lesson verification is unavailable; candidate remains unpromoted");
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
