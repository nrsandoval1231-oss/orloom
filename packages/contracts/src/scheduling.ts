import { createHash } from "node:crypto";
import type { SchedulingChoice, SchedulingSnapshot, SliceInput } from "./mission.js";
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
