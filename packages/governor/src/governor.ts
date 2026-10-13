import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Lane, Mission, MissionConflictError, MissionInput, MissionPlan, MissionSlice, MissionStore, MissionValidationError, SliceInput, validateMission, validatePlan } from "../../contracts/src/mission.js";

export interface GovernorConfig { maxLanes: number; capacitySlots: number; leaseSeconds: number; trustedCheckPolicyDigest: string | null; trustedCheckPolicy?: string[]; executionConfigured?: boolean; }
export function validateGovernorConfig(config: GovernorConfig) {
  if (!Number.isInteger(config.maxLanes) || config.maxLanes < 1 || config.maxLanes > 6 || !Number.isInteger(config.capacitySlots) || config.capacitySlots < 0 || config.capacitySlots > config.maxLanes || !Number.isInteger(config.leaseSeconds) || config.leaseSeconds < 30 || config.leaseSeconds > 3600) throw new Error("Invalid governor lane or lease configuration");
  return config;
}
export function makeMissionInput(input: MissionInput) { validateMission(input); return input; }
export function makePlan(missionId: string, slices: SliceInput[], recommendedBy: string) { validatePlan(missionId, slices, recommendedBy); return slices; }
export class MissionGovernor {
  constructor(private readonly store: MissionStore, private readonly config: GovernorConfig) {
    validateGovernorConfig(config);
  }
  submit(input: MissionInput) { validateMission(input); return this.store.submit(input); }
  recommend(missionId: string, slices: SliceInput[], recommendedBy: string) { validatePlan(missionId, slices, recommendedBy); const allowed=new Set(this.config.trustedCheckPolicy??[]);if(slices.some(s=>!s.checks.length||s.checks.some(c=>!allowed.has(c))))throw new MissionValidationError("slice checks must be selected from the trusted operator policy");return this.store.recommendPlan(missionId, slices, recommendedBy); }
  approve(missionId: string) { return this.store.approvePlan(missionId); }
  claim() { if (!this.config.capacitySlots || !this.config.trustedCheckPolicyDigest || !this.config.executionConfigured) return Promise.resolve(null); return this.store.claim(this.config.leaseSeconds, this.config.trustedCheckPolicyDigest); }
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
  get(id: string) { return this.store.getMission(id); }
  events(id: string, cursor: number) { return this.store.events(id, cursor); }
  expire() { return this.store.expire(); }
  configureCapacity(count:number,digest:string|null,expires:string|null){return this.store.configureCapacity(count,digest,expires);}
}
export function newMissionId() { return randomUUID(); }
export function newSecret() { return randomBytes(32).toString("base64url"); }
export function secretMatches(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export type { Mission, MissionPlan, MissionSlice, MissionStore };
