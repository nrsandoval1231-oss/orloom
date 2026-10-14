import type { ProgressStatus, TrustedStrategyPolicy } from "../../contracts/src/mission.js";

export interface DecisionSnapshotV1 {
  version: "orloom.decision-snapshot.v1";
  missionId: string;
  sliceId: string;
  leaseEpoch: number;
  revision: number;
  planDigest: string;
  trustedCheckPolicyDigest: string;
  recoveryPolicyDigest: string;
  leaseExpiresAt: string;
  /** Governor-derived budget ceilings and committed reservations at capture time. */
  missionBudgetCents: number;
  sliceBudgetCents: number;
  reservedBudgetCents: number;
  /** Worker-reported counters are context only, not trusted metered spend. */
  reportedUsage: { providerCalls: number; inputTokens: number; outputTokens: number; wallMs: number };
  /** Digest references only; never raw output or source content. */
  evidenceRefs: string[];
  eventId: string;
  targetCheckId: string;
  status: ProgressStatus;
  reasonCode: string;
  strategyId: string;
  checkId: string;
  triedStrategies: string[];
  alternatives: Array<{ id: string; policy: TrustedStrategyPolicy }>;
  lessonIds: string[];
  lessonBindings: Array<{ id: string; lessonVersion: number; challengeDigest: string; policyDigest: string; strategyId: string }>;
  preferredStrategyId: string | null;
}

export interface JudgmentV1 {
  version: "orloom.judgment.v1";
  snapshotDigest: string;
  source: "deterministic" | "jev";
  answer: "continue" | "change_strategy" | "request_replan" | "escalate";
  strategyId: string | null;
  checkId: string | null;
  policyVersion: string;
  policyDigest: string;
  modelId: string | null;
  confidence: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}
