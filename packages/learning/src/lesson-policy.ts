import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";

export interface LessonProvenance {
  repository: string; cohort: string; fromCheckId: string; strategyId: string;
  policyVersion: string; policyDigest: string; evidenceEventIds: string[];
  metric: "trusted_check_pass_rate"; direction: "increase";
  baseline: { failed: number; observed: number };
  outcome: { passed: number; observed: number };
}

export function lessonChallengeDigest(input: LessonProvenance): string {
  const normalized = { ...input, evidenceEventIds: [...input.evidenceEventIds].sort() };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function lessonRule(input: Pick<LessonProvenance, "fromCheckId" | "strategyId" | "cohort">): string {
  return `For target ${input.fromCheckId} in ${input.cohort}, prefer approved strategy ${input.strategyId} after a comparable trusted-check failure.`;
}
