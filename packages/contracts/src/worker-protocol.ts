import type { MissionInput, SliceInput } from "./mission.js";

/** Stable worker-facing envelope. It grants a bounded candidate-producing lease only. */
export interface WorkerLeaseContract {
  protocol: "orloom.worker-lease.v1";
  mission: Pick<MissionInput, "repository" | "baseSha" | "objective" | "acceptance"> & { id: string };
  slice: Pick<SliceInput, "id" | "objective" | "dependencies" | "owner" | "scopes" | "checks">;
  capacitySlot: number;
  leaseEpoch: number;
  leaseToken: string;
  capabilityToken: string;
  leaseExpiresAt: string;
  trustedCheckPolicyDigest: string;
  planDigest: string;
  executionLimits: WorkerExecutionLimits;
}

export interface WorkerCandidateResult { candidateSha: string; evidenceRefs: string[]; }
export interface WorkerBlockedOrUnknownResult { outcome: "BLOCKED" | "UNKNOWN"; reasonCode: "dependency_missing" | "provider_unavailable" | "budget_exhausted" | "scope_conflict" | "other"; evidenceRefs: string[]; }
export type WorkerResult = WorkerCandidateResult | WorkerBlockedOrUnknownResult;
export interface WorkerExecutionLimits {
  reservedBudgetCents: number;
  maxProviderCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallSeconds: number;
  allowedProviders: string[];
  allowedModels: string[];
}
export type WorkerSliceScope = Pick<SliceInput, "id" | "objective" | "dependencies" | "owner" | "scopes" | "checks"> & { missionId: string; };
export interface WorkerExecutionBinding { planDigest: string; limits: WorkerExecutionLimits; }
export interface WorkerLeaseHeaders { authorization: `Bearer ${string}`; "x-orloom-lease-token": string; "x-orloom-lease-epoch": `${number}`; }

export function workerLeaseContract(value: Omit<WorkerLeaseContract, "protocol">): WorkerLeaseContract {
  return { protocol: "orloom.worker-lease.v1", ...value };
}
