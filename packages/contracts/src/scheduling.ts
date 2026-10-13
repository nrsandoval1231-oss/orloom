import { createHash } from "node:crypto";
import { MissionValidationError, type SchedulingChoice, type SchedulingDecisionRecord, type SchedulingSnapshot, type SliceInput } from "./mission.js";
import { canonicalJson } from "../../judgment/src/canonical.js";

/** Longest remaining DAG path in slice-count units; this is a critical-path proxy, not a duration estimate. */
export function downstreamDepths(slices: readonly Pick<SliceInput, "id">[] & readonly { dependencies: string[] }[]): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const slice of slices) for (const dependency of slice.dependencies) {
    const list = children.get(dependency) ?? []; list.push(slice.id); children.set(dependency, list);
  }
  const memo = new Map<string, number>();
  const depth = (id: string): number => {
    const known = memo.get(id); if (known !== undefined) return known;
    const result = (children.get(id) ?? []).reduce((best, child) => Math.max(best, 1 + depth(child)), 0);
    memo.set(id, result); return result;
  };
  for (const slice of slices) depth(slice.id);
  return memo;
}

/** Stable order: critical path first, then known scope-breadth/wildcard risk, lower slice cost, and lexical identity. Scope risk is a serialization signal, not a failure probability. */
export function rankSchedulingChoices(choices: readonly SchedulingChoice[]): SchedulingChoice[] {
  return [...choices].sort((a, b) => b.downstreamDepth - a.downstreamDepth || a.scopeRisk - b.scopeRisk
    || a.budgetCents - b.budgetCents || a.repository.localeCompare(b.repository)
    || a.missionId.localeCompare(b.missionId) || a.sliceId.localeCompare(b.sliceId));
}

export function schedulingSnapshotDigest(snapshot: Pick<SchedulingSnapshot, "freeCapacity" | "choices">): string {
  return createHash("sha256").update(canonicalJson({ freeCapacity: snapshot.freeCapacity, choices: rankSchedulingChoices(snapshot.choices) })).digest("hex");
}

export function validateSchedulingDecision(value: SchedulingDecisionRecord): void {
  if(!value||typeof value!=="object"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.decisionId)
    ||! /^[a-f0-9]{64}$/.test(value.snapshotDigest)||! /^[a-f0-9]{64}$/.test(value.trustedCheckPolicyDigest)
    ||!(value.recoveryPolicyDigest===""||/^[a-f0-9]{64}$/.test(value.recoveryPolicyDigest))
    ||value.dispatchMayHaveOccurred!==true||!(["dispatch_possible","advice_resolved","no_lease"] as const).includes(value.phase)
    ||!(["pending","selected","invalid","unknown","no_lease"] as const).includes(value.status)
    ||(value.preferredCandidateId!==null&&(typeof value.preferredCandidateId!=="string"||value.preferredCandidateId.length>130))
    ||(value.validatedCandidateId!==null&&(typeof value.validatedCandidateId!=="string"||value.validatedCandidateId.length>130))
    ||(value.modelId!==null&&(typeof value.modelId!=="string"||value.modelId.length>256||!/^[A-Za-z0-9._:-]+$/.test(value.modelId)))
    ||!(["measured","unknown"] as const).includes(value.tokenUsageStatus)
    ||(value.tokenUsageStatus==="measured"&&(!value.tokenUsage||!Number.isSafeInteger(value.tokenUsage.inputTokens)||value.tokenUsage.inputTokens<0||!Number.isSafeInteger(value.tokenUsage.outputTokens)||value.tokenUsage.outputTokens<0))
    ||(value.tokenUsageStatus==="unknown"&&value.tokenUsage!==null)
    ||(value.phase==="dispatch_possible"&&(value.status!=="pending"||value.modelId!==null||value.tokenUsage!==null||value.preferredCandidateId!==null||value.validatedCandidateId!==null))
    ||(value.phase==="no_lease"&&value.status!=="no_lease"))throw new MissionValidationError("invalid bounded scheduling decision record");
}
