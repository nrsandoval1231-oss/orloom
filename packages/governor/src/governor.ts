import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DecisionSnapshotV1, JudgmentV1 } from "../../judgment/src/types.js";
import { Lane, LessonCandidate, LessonValidationChallenge, Mission, MissionConflictError, MissionInput, MissionPlan, MissionSlice, MissionStore, MissionValidationError, ProgressReceipt, ProgressV1, SliceInput, TrustedStrategyPolicy, validateMission, validatePlan } from "../../contracts/src/mission.js";

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
