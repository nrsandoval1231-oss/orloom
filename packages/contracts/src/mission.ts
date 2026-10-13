/** Logical scope owner. Execution capacity is represented only by attested slots. */
export type Lane = string;
export type MissionStatus = "planning" | "ready" | "running" | "awaiting_verification" | "verified" | "blocked" | "unknown";
export type SliceStatus = "waiting_dependency" | "blocked" | "ready" | "running" | "awaiting_verification" | "verified" | "failed" | "unknown";

export interface MissionInput { repository: string; baseSha: string; objective: string; acceptance: string[]; budgetCents: number; }
export interface SliceInput { id: string; objective: string; dependencies: string[]; owner: Lane; scopes: string[]; checks: string[]; budgetCents: number; }
export interface MissionPlan { missionId: string; slices: SliceInput[]; recommendedBy: string; recommendedAt: string; approvedAt: string | null; }
export interface Mission extends MissionInput { id: string; status: MissionStatus; reservedCents: number; createdAt: string; }
export interface MissionSlice extends SliceInput { missionId: string; status: SliceStatus; leaseEpoch: number; leaseToken: string | null; leaseExpiresAt: string | null; candidateSha: string | null; evidenceRefs: string[]; }
export interface MissionEvent { cursor: number; missionId: string; type: string; data: Record<string, unknown>; createdAt: string; }
export interface LeaseGrant { mission: Mission; slice: MissionSlice; epoch: number; leaseToken: string; capabilityToken: string; leaseExpiresAt: string; capacitySlot: number; trustedCheckPolicyDigest: string; }
export interface MissionStore {
  configureCapacity(count: number, evidenceDigest: string | null, expiresAt: string | null): Promise<void>;
  submit(input: MissionInput): Promise<Mission>;
  recommendPlan(missionId: string, slices: SliceInput[], recommendedBy: string): Promise<MissionPlan>;
  approvePlan(missionId: string): Promise<Mission>;
  getMission(missionId: string): Promise<{ mission: Mission; plan: MissionPlan | null; slices: MissionSlice[] } | null>;
  events(missionId: string, after: number): Promise<MissionEvent[]>;
  claim(leaseSeconds: number, policyDigest: string, now?: Date): Promise<LeaseGrant | null>;
  heartbeat(missionId: string, sliceId: string, epoch: number, leaseToken: string, capabilityToken: string, leaseSeconds: number): Promise<MissionSlice>;
  complete(missionId: string, sliceId: string, epoch: number, leaseToken: string, capabilityToken: string, candidateSha: string, evidenceRefs: string[]): Promise<MissionSlice>;
  integrate(missionId:string,sliceId:string,candidateSha:string,policyDigest:string,evidenceRefs:string[],integrationEvidenceRef:string,verifierId:string):Promise<MissionSlice>;
  reportOutcome(missionId:string,sliceId:string,epoch:number,leaseToken:string,capabilityToken:string,outcome:"BLOCKED"|"UNKNOWN",reasonCode:string,evidenceRefs:string[]):Promise<MissionSlice>;
  expire(now?: Date, limit?: number): Promise<number>;
}

export class MissionValidationError extends Error { constructor(message: string) { super(message); this.name = "MissionValidationError"; } }
export class MissionConflictError extends Error { constructor(message: string) { super(message); this.name = "MissionConflictError"; } }

const sha = /^[0-9a-f]{40}$/i;
const safeText = (s: unknown, max: number) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
export function validateMission(value: MissionInput): void {
  if (!safeText(value.repository, 256) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) throw new MissionValidationError("repository must be owner/name");
  if (!sha.test(value.baseSha)) throw new MissionValidationError("baseSha must be a full commit SHA");
  if (!safeText(value.objective, 20000)) throw new MissionValidationError("objective is required");
  if (!Array.isArray(value.acceptance) || value.acceptance.length < 1 || value.acceptance.length > 100 || value.acceptance.some(x => !safeText(x, 2000))) throw new MissionValidationError("acceptance must contain 1 to 100 non-empty criteria");
  if (!Number.isSafeInteger(value.budgetCents) || value.budgetCents < 1 || value.budgetCents > 100_000_000) throw new MissionValidationError("budgetCents is outside the allowed range");
}
export function canonicalRepository(repository: string): string { return repository.toLowerCase(); }
function validScope(scope: string) {
  return typeof scope === "string" && scope.length > 0 && scope.length <= 512 && !scope.startsWith("/") && !scope.includes("\\") && !scope.split("/").some(s => !s || s === "." || s === "..") && !/[\x00-\x1f]/.test(scope);
}
export function validatePlan(missionId: string, slices: SliceInput[], recommendedBy: string): void {
  if (!safeText(missionId, 64) || !safeText(recommendedBy, 128)) throw new MissionValidationError("invalid plan identity");
  if (!Array.isArray(slices) || slices.length < 1 || slices.length > 100) throw new MissionValidationError("plan must contain 1 to 100 slices");
  const byId = new Map<string, SliceInput>();
  for (const s of slices) {
    if (!s || typeof s !== "object") throw new MissionValidationError("invalid slice record");
    if (!safeText(s.id, 64) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s.id) || byId.has(s.id)) throw new MissionValidationError("slice ids must be unique and simple");
    if (!safeText(s.objective, 4000) || !safeText(s.owner,128) || /[\x00-\x1f]/.test(s.owner) || !Number.isSafeInteger(s.budgetCents) || s.budgetCents < 0) throw new MissionValidationError("invalid slice objective, ownership, or budget");
    if (!Array.isArray(s.scopes) || !s.scopes.length || s.scopes.length > 100 || s.scopes.some(p => !validScope(p))) throw new MissionValidationError("slice scope is missing or unsafe");
    if (!Array.isArray(s.dependencies) || !Array.isArray(s.checks) || s.checks.some(c => !safeText(c, 1000))) throw new MissionValidationError("invalid slice dependencies or checks");
    byId.set(s.id, s);
  }
  for (const s of slices) if (s.dependencies.some(d => !byId.has(d) || d === s.id)) throw new MissionValidationError("plan contains an unknown or self dependency");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new MissionValidationError("plan dependencies must be acyclic"); if (visited.has(id)) return; visiting.add(id); for (const d of byId.get(id)!.dependencies) visit(d); visiting.delete(id); visited.add(id); };
  for (const id of byId.keys()) visit(id);
  const sum = slices.reduce((n, s) => n + s.budgetCents, 0);
  if (!Number.isSafeInteger(sum)) throw new MissionValidationError("plan budget overflow");
}

export function scopesOverlap(a: string, b: string): boolean {
  // Wildcards are intentionally conservative: uncertain matches serialize.
  if (/[?*[{]/.test(a) || /[?*[{]/.test(b)) return true;
  const x = a.replace(/\/$/, ""), y = b.replace(/\/$/, "");
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
