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
  eventId: string;
  targetCheckId: string;
  status: ProgressStatus;
  reasonCode: string;
  strategyId: string;
  checkId: string;
  triedStrategies: string[];
  alternatives: Array<{ id: string; policy: TrustedStrategyPolicy }>;
  lessonIds: string[];
  lessonBindings: Array<{ id: string; lessonVersion: number; policyDigest: string; strategyId: string }>;
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
