import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";

export interface LessonProvenance {
  repository: string; cohort: string; fromCheckId: string; strategyId: string;
  policyVersion: string; policyDigest: string; evidenceEventIds: string[];
  metric: "trusted_check_pass_rate"; direction: "increase";
  baseline: { failed: number; observed: number };
  outcome: { passed: number; observed: number };
}

export interface LessonEpisodeObservation {
  eventId: string;
  repository: string;
  missionId: string;
  sliceId: string;
  leaseEpoch: number;
  ordinal: number;
  status: string;
  decisionStatus: string;
  targetCheckId: string;
  strategyId: string;
  trustedCheckPolicyDigest: string;
  recoveryPolicyDigest: string;
  cohort: string;
}

/** Counts distinct slice episodes; lease epochs distinguish observations within a pair. */
export function lessonEpisodeKey(observation: Pick<LessonEpisodeObservation, "missionId" | "sliceId">): string {
  return `${observation.missionId}:${observation.sliceId}`;
}

/**
 * A small context label only: normalize/sort the declared scopes and use the
 * first path's root component. It is not proof that two scopes are equivalent.
 */
export function scopeCohort(scopes: unknown): string | null {
  if (!Array.isArray(scopes) || scopes.length === 0
    || scopes.some((scope) => typeof scope !== "string" || scope.trim().length === 0)) {
    return null;
  }
  const ordered = (scopes as string[]).map((scope) => scope.trim().toLowerCase()).sort();
  const root = ordered[0]?.split("/")[0];
  return root && !/[\x00-\x1f]/.test(root) ? root : null;
}

/** Only durable committed observations from the same comparable episode count. */
export function eligibleLessonPair(failure: LessonEpisodeObservation, success: LessonEpisodeObservation): boolean {
  return failure.decisionStatus === "committed"
    && success.decisionStatus === "committed"
    && failure.status === "failed"
    && success.status === "passed"
    && failure.repository === success.repository
    && failure.cohort === success.cohort
    && failure.missionId === success.missionId
    && failure.sliceId === success.sliceId
    && failure.leaseEpoch === success.leaseEpoch
    && failure.ordinal < success.ordinal
    && failure.targetCheckId === success.targetCheckId
    && failure.strategyId !== success.strategyId
    && failure.trustedCheckPolicyDigest === success.trustedCheckPolicyDigest
    && failure.recoveryPolicyDigest === success.recoveryPolicyDigest;
}

export function lessonChallengeDigest(input: LessonProvenance): string {
  const normalized = { ...input, evidenceEventIds: [...input.evidenceEventIds].sort() };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function lessonRule(input: Pick<LessonProvenance, "fromCheckId" | "strategyId" | "cohort">): string {
  return `For target ${input.fromCheckId} in ${input.cohort}, prefer approved strategy ${input.strategyId} after a comparable trusted-check failure.`;
}
