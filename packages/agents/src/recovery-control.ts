import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";
import type { ProgressReceipt, RecoveryPolicyLease, RecoveryProgress, TrustedStrategyPolicy } from "../../contracts/src/mission.js";
import type { WorkerLeaseContract } from "../../contracts/src/worker-protocol.js";
import { HttpControlPlane, WorkerProtocolError } from "./worker.js";

export interface WorkerRecoveryPolicy extends RecoveryPolicyLease {
  version: "orloom.recovery-policy.v1";
  missionId: string;
  sliceId: string;
  leaseEpoch: number;
  strategies: Record<string, TrustedStrategyPolicy>;
}

/** Typed control-plane transport only. It neither creates trusted evidence nor
 * translates builder run_check output into trusted-check completion. */
export class HttpRecoveryControlPlane extends HttpControlPlane {
  constructor(private readonly recoveryBaseUrl: string, bootstrapToken: string, private readonly recoveryFetch: typeof fetch = fetch) {
    super(recoveryBaseUrl, bootstrapToken, recoveryFetch);
  }

  async recoveryPolicy(lease: WorkerLeaseContract): Promise<WorkerRecoveryPolicy> {
    const value = await this.recoveryRequest(lease, "recovery-policy", "GET") as WorkerRecoveryPolicy;
    if (value?.version !== "orloom.recovery-policy.v1" || value.missionId !== lease.mission.id || value.sliceId !== lease.slice.id || value.leaseEpoch !== lease.leaseEpoch
      || value.planDigest !== lease.planDigest || value.trustedCheckPolicyDigest !== lease.trustedCheckPolicyDigest
      || !/^[a-f0-9]{64}$/.test(value.recoveryPolicyDigest) || !value.strategies || typeof value.strategies !== "object" || Array.isArray(value.strategies)
      || Object.entries(value.strategies).some(([key, strategy])=>!id(key) || !lease.slice.checks.includes(key) || !validStrategy(strategy))) {
      throw new WorkerProtocolError("Recovery policy does not match the immutable lease");
    }
    return value;
  }

  async recordProgress(lease: WorkerLeaseContract, progress: RecoveryProgress): Promise<ProgressReceipt> {
    if (progress.missionId !== lease.mission.id || progress.sliceId !== lease.slice.id || progress.leaseEpoch !== lease.leaseEpoch
      || progress.planDigest !== lease.planDigest || progress.trustedCheckPolicyDigest !== lease.trustedCheckPolicyDigest
      || progress.phase !== "trusted_check" || ((progress.status === "passed" || progress.status === "failed") && progress.version !== "orloom.progress.v2")) {
      throw new WorkerProtocolError("Only lease-bound trusted recovery progress is accepted");
    }
    const policy = await this.recoveryPolicy(lease);
    if (progress.recoveryPolicyDigest !== policy.recoveryPolicyDigest) throw new WorkerProtocolError("Recovery policy changed before progress submission");
    const value = await this.recoveryRequest(lease, "progress", "POST", progress) as ProgressReceipt;
    if (!validReceipt(value, lease, progress, policy)) {
      throw new WorkerProtocolError("Controller returned an invalid recovery receipt; do not retry or execute it");
    }
    return value;
  }

  private async recoveryRequest(lease: WorkerLeaseContract, route: "recovery-policy" | "progress", method: "GET" | "POST", body?: RecoveryProgress): Promise<unknown> {
    const routePath = `/api/worker/missions/${encodeURIComponent(lease.mission.id)}/slices/${encodeURIComponent(lease.slice.id)}/${route}`;
    const response = await this.recoveryFetch(new URL(routePath, this.recoveryBaseUrl), {
      method, headers: { authorization: `Bearer ${lease.capabilityToken}`, "content-type": "application/json", "x-orloom-lease-token": lease.leaseToken, "x-orloom-lease-epoch": String(lease.leaseEpoch) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new WorkerProtocolError(`${route} failed with HTTP ${response.status}; no automatic retry`);
    if (!response.body) throw new WorkerProtocolError("Recovery response has no body");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256_000) throw new WorkerProtocolError("Recovery response exceeds byte limit");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

const exact = (value: unknown, fields: string[]): boolean => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");
const id = (value: unknown): value is string => typeof value === "string" && /^[-a-zA-Z0-9_.:]{1,128}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128 && value.every(id);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function validReceipt(value: ProgressReceipt, lease: WorkerLeaseContract, progress: RecoveryProgress, policy: WorkerRecoveryPolicy): boolean {
  if (!exact(value,["duplicate","action","snapshot","judgment"]) || typeof value.duplicate !== "boolean") return false;
  const { action: a, snapshot: s, judgment: j }=value;
  if (!exact(a,["version","eventId","revision","action","strategyId","checkId","expectedSignal","policyVersion","policyDigest","lessonIds","lessonBindings"])
    || !exact(j,["version","snapshotDigest","source","answer","strategyId","checkId","policyVersion","policyDigest","modelId","confidence","usage"])
    || !exact(s,["version","missionId","sliceId","leaseEpoch","revision","planDigest","trustedCheckPolicyDigest","recoveryPolicyDigest","leaseExpiresAt","missionBudgetCents","sliceBudgetCents","reservedBudgetCents","reportedUsage","evidenceRefs","eventId","targetCheckId","status","reasonCode","strategyId","checkId","triedStrategies","alternatives","lessonIds","lessonBindings","preferredStrategyId"])) return false;
  if (a.version !== "orloom.governor-action.v1" || j.version !== "orloom.judgment.v1" || s.version !== "orloom.decision-snapshot.v1"
    || a.eventId !== progress.eventId || s.eventId !== progress.eventId || a.revision !== progress.ordinal || s.revision !== progress.ordinal
    || !Number.isSafeInteger(a.revision) || a.revision < 1 || a.policyDigest !== policy.recoveryPolicyDigest || j.policyDigest !== policy.recoveryPolicyDigest
    || s.recoveryPolicyDigest !== policy.recoveryPolicyDigest || s.trustedCheckPolicyDigest !== lease.trustedCheckPolicyDigest
    || s.planDigest !== lease.planDigest || s.missionId !== lease.mission.id || s.sliceId !== lease.slice.id || s.leaseEpoch !== lease.leaseEpoch
    || s.targetCheckId !== progress.targetCheckId || s.strategyId !== progress.strategyId || s.checkId !== progress.checkId
    || s.status !== progress.status || s.reasonCode !== progress.reasonCode || !equal(s.reportedUsage,progress.counters) || !equal(s.evidenceRefs,progress.evidenceRefs)
    || typeof s.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(s.leaseExpiresAt))
    || ![s.missionBudgetCents,s.sliceBudgetCents,s.reservedBudgetCents].every(count) || s.sliceBudgetCents !== lease.executionLimits.reservedBudgetCents
    || s.reservedBudgetCents < s.sliceBudgetCents || s.reservedBudgetCents > s.missionBudgetCents
    || !["continue","change_strategy","request_replan","escalate"].includes(a.action) || a.action !== j.answer
    || a.strategyId !== j.strategyId || a.checkId !== j.checkId || !id(a.policyVersion) || a.policyVersion !== j.policyVersion
    || !digest(j.snapshotDigest) || j.snapshotDigest !== createHash("sha256").update(canonicalJson(s)).digest("hex")) return false;
  if (!ids(s.triedStrategies) || s.triedStrategies.some(x=>!Object.hasOwn(policy.strategies,x)) || !Array.isArray(s.alternatives) || s.alternatives.length>128
    || s.alternatives.some(x=>!exact(x,["id","policy"]) || !id(x.id) || !lease.slice.checks.includes(x.id) || !Object.hasOwn(policy.strategies,x.id) || !equal(x.policy,policy.strategies[x.id]))
    || (s.preferredStrategyId!==null && !s.alternatives.some(x=>x.id===s.preferredStrategyId))) return false;
  if (!ids(a.lessonIds) || !ids(s.lessonIds) || !equal(a.lessonIds,s.lessonIds) || !Array.isArray(a.lessonBindings) || a.lessonBindings.length>128
    || !Array.isArray(s.lessonBindings) || !equal(a.lessonBindings,s.lessonBindings)
    || a.lessonBindings.some(x=>!exact(x,["id","lessonVersion","challengeDigest","policyDigest","strategyId"]) || !id(x.id) || !a.lessonIds.includes(x.id)
      || !Number.isSafeInteger(x.lessonVersion) || x.lessonVersion<1 || !digest(x.challengeDigest) || x.policyDigest!==policy.recoveryPolicyDigest || !Object.hasOwn(policy.strategies,x.strategyId))) return false;
  if (j.source === "deterministic") {
    if (j.modelId!==null || j.confidence!==null || j.usage!==null) return false;
  } else if (j.source === "jev") {
    if (typeof j.modelId!=="string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(j.modelId) || typeof j.confidence!=="number" || !Number.isFinite(j.confidence) || j.confidence<0 || j.confidence>1
      || !exact(j.usage,["inputTokens","outputTokens"]) || !count(j.usage?.inputTokens) || !count(j.usage?.outputTokens)) return false;
  } else return false;
  if ((progress.status==="failed" && a.action==="continue") || (["blocked","unknown"].includes(progress.status) && a.action!=="escalate")) return false;
  if (a.action === "change_strategy") {
    if (!id(a.strategyId) || !id(a.checkId) || a.strategyId===progress.strategyId || s.triedStrategies.includes(a.strategyId)) return false;
    const next=policy.strategies[a.strategyId];
    return !!next && lease.slice.checks.includes(a.strategyId) && s.alternatives.some(x=>x.id===a.strategyId) && next.checkId===a.checkId
      && next.version===a.policyVersion && next.targetCheckIds.includes(progress.targetCheckId) && next.expectedSignal===a.expectedSignal;
  }
  return a.strategyId===null && a.checkId===null && policy.strategies[progress.strategyId]?.expectedSignal===a.expectedSignal;
}

function validStrategy(value: TrustedStrategyPolicy): boolean {
  return exact(value,["checkId","version","expectedSignal","scopeClasses","targetCheckIds"]) && id(value.checkId) && id(value.version)
    && typeof value.expectedSignal==="string" && value.expectedSignal.length>0 && value.expectedSignal.length<=4000
    && Array.isArray(value.scopeClasses) && value.scopeClasses.length>0 && value.scopeClasses.length<=128 && value.scopeClasses.every(x=>typeof x==="string" && x.length>0 && x.length<=128)
    && ids(value.targetCheckIds) && value.targetCheckIds.length>0;
}
