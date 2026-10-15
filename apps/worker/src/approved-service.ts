import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/judgment/src/canonical.js";
import type { IntegrationRequestV1, MissionStore, LeaseGrant } from "../../../packages/contracts/src/mission.js";
import type { LocalIntegrationAuthority, MissionGovernor, TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";
import type { DeliveryAuthority, DeliveryCommandV1, DeliveryPolicy } from "../../../packages/integration/src/delivery.js";
import type { WorkerExecutionLimits, WorkerLeaseContract } from "../../../packages/contracts/src/worker-protocol.js";
import type { ApprovedWorkerLaneResult } from "../../control-plane/src/approved-worker-lane.js";

export interface ApprovedWorkerTaskBinding {
  readonly missionId: string;
  readonly sliceId: string;
  readonly repository: string;
  readonly baseSha: string;
  readonly planDigest: string;
  readonly trustedCheckPolicyDigest: string;
  readonly maxBudgetCents: number;
  readonly expiresAt: string;
}

export type ApprovedWorkerServiceResult = ApprovedWorkerLaneResult | "idle" | "already_verified" | "awaiting_review" | "delivered";

export interface ApprovedWorkerServiceOptions {
  readonly task: ApprovedWorkerTaskBinding;
  readonly executionLimits: WorkerExecutionLimits;
  readonly minimumSliceBudgetCents: number;
  readonly leaseSeconds: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** Optional explicit owner-approved review request. Omission leaves verified candidates awaiting review. */
  readonly integrationRequest?: IntegrationRequestV1;
  /** Explicitly guarded, single-slice delivery command. Omission leaves integration local. */
  readonly deliveryCommand?: DeliveryCommandV1;
}

export interface ApprovedWorkerServiceDependencies {
  readonly governor: MissionGovernor;
  readonly store: MissionStore;
  readonly trustedChecks: TrustedCheckCoordinator;
  /** Reconcile only this task's owned runtime records; implementations must reject UNKNOWN. */
  readonly reconcileInterrupted: (target: ApprovedClaimTarget) => Promise<void>;
  /** Replay only retained settlement evidence for this exact task. */
  readonly reconcileRetained: (target: ApprovedClaimTarget, leaseEpoch: number) => Promise<void>;
  /** Production composition supplies runApprovedDockerWorkerLane here. */
  readonly executeLane: (lease: WorkerLeaseContract, binding: ApprovedWorkerTaskBinding, signal: AbortSignal) => Promise<ApprovedWorkerLaneResult>;
  readonly integrationAuthority?: LocalIntegrationAuthority;
  /** Safely copies authentic admitted candidate and verifier evidence into the configured integration stores. */
  readonly prepareCertifiedIntegration?: (record: NonNullable<Awaited<ReturnType<MissionStore["getMission"]>>>, request: IntegrationRequestV1) => Promise<void>;
  readonly deliveryPolicy?: DeliveryPolicy;
  readonly deliveryAuthority?: DeliveryAuthority;
}

export interface ApprovedClaimTarget {
  missionId: string;
  sliceId: string;
  repository: string;
  baseSha: string;
  planDigest: string;
  maxBudgetCents: number;
}

export interface ApprovedRetainedRuntimeBridge {
  reconcileRetained(controllerRunId?: string, target?: { missionId: string; sliceId: string }): Promise<Array<"settled" | "observed_absent" | "quarantined" | "ignored">>;
}

/** Same identity derivation as docker-runtime.controllerRunIdFor, from durable binding facts. */
export function controllerRunIdForApprovedTask(task: ApprovedWorkerTaskBinding, leaseEpoch: number): string {
  return createHash("sha256").update(JSON.stringify([
    "orloom.worker-lease.v1", task.missionId, task.sliceId, leaseEpoch, task.planDigest, task.trustedCheckPolicyDigest,
  ])).digest("hex");
}

/** Replay only this task's retained runtime proofs. `ignored` is not trusted here:
 * only the store's distinct observed_absent result means validated normal completion. */
export async function reconcileApprovedWorkerRetained(bridge: ApprovedRetainedRuntimeBridge, target: ApprovedClaimTarget, controllerRunId: string): Promise<void> {
  const outcomes = await bridge.reconcileRetained(controllerRunId, { missionId: target.missionId, sliceId: target.sliceId });
  if (outcomes.some(outcome => outcome === "quarantined" || outcome === "ignored")) throw new Error("Retained runtime settlement is malformed, stale, or quarantined");
}

type PersistedMission = NonNullable<Awaited<ReturnType<MissionStore["getMission"]>>>;

function assertDurableTaskBinding(record: PersistedMission | null, task: ApprovedWorkerTaskBinding): PersistedMission {
  if (!record || record.mission.id !== task.missionId || record.mission.repository !== task.repository || record.mission.baseSha !== task.baseSha || record.plan?.approvedAt == null || record.plan.missionId !== task.missionId || record.plan.slices.length !== 1) throw new Error("Approved task no longer matches a durably approved single-slice mission");
  const planDigest = createHash("sha256").update(canonicalJson(record.plan.slices)).digest("hex");
  if (planDigest !== task.planDigest || record.plan.slices[0]?.id !== task.sliceId) throw new Error("Durable approved plan digest differs from the exact task binding");
  const persistedSlice = record.slices.find(row => row.id === task.sliceId), planSlice = record.plan.slices[0];
  if (!persistedSlice || !planSlice || canonicalJson({ id: persistedSlice.id, objective: persistedSlice.objective, dependencies: persistedSlice.dependencies, owner: persistedSlice.owner, scopes: persistedSlice.scopes, checks: persistedSlice.checks, budgetCents: persistedSlice.budgetCents }) !== canonicalJson(planSlice)) throw new Error("Durable task slice differs from its approved plan binding");
  return record;
}

function targetFor(task: ApprovedWorkerTaskBinding): ApprovedClaimTarget {
  return { missionId: task.missionId, sliceId: task.sliceId, repository: task.repository, baseSha: task.baseSha, planDigest: task.planDigest, maxBudgetCents: task.maxBudgetCents };
}

function validateOptions(options: ApprovedWorkerServiceOptions, now: number): void {
  const { task, executionLimits } = options;
  const sha1 = /^[a-f0-9]{40}$/i, sha256 = /^[a-f0-9]{64}$/i;
  if (!task.missionId || !task.sliceId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repository) || !sha1.test(task.baseSha) || !sha256.test(task.planDigest) || !sha256.test(task.trustedCheckPolicyDigest)) throw new Error("Approved task identity is invalid");
  const expiry = Date.parse(task.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error("Approved task manifest is expired");
  if (!Number.isSafeInteger(task.maxBudgetCents) || task.maxBudgetCents < 1 || !Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 1) throw new Error("Approved task budget or lease lifetime is invalid");
  const numericLimits = [executionLimits.reservedBudgetCents, executionLimits.maxProviderCalls, executionLimits.maxInputTokens, executionLimits.maxOutputTokens, executionLimits.maxWallSeconds];
  if (numericLimits.some(value => !Number.isSafeInteger(value) || value < 1) || !Array.isArray(executionLimits.allowedProviders) || !executionLimits.allowedProviders.length || !Array.isArray(executionLimits.allowedModels) || !executionLimits.allowedModels.length) throw new Error("Configured worker execution limits are not enabled");
  if (executionLimits.reservedBudgetCents > task.maxBudgetCents) throw new Error("Configured execution reservation exceeds approved task budget");
  if (!Number.isSafeInteger(options.minimumSliceBudgetCents) || options.minimumSliceBudgetCents < 1 || options.minimumSliceBudgetCents > task.maxBudgetCents) throw new Error("Worst-case provider cost exceeds the approved task budget");
}

function workerLease(grant: LeaseGrant, limits: WorkerExecutionLimits): WorkerLeaseContract {
  return {
    protocol: "orloom.worker-lease.v1",
    mission: { id: grant.mission.id, repository: grant.mission.repository, baseSha: grant.mission.baseSha, objective: grant.mission.objective, acceptance: grant.mission.acceptance },
    slice: { id: grant.slice.id, objective: grant.slice.objective, dependencies: grant.slice.dependencies, owner: grant.slice.owner, scopes: grant.slice.scopes, checks: grant.slice.checks },
    capacitySlot: grant.capacitySlot, leaseEpoch: grant.epoch, leaseToken: grant.leaseToken, capabilityToken: grant.capabilityToken,
    leaseExpiresAt: grant.leaseExpiresAt, trustedCheckPolicyDigest: grant.trustedCheckPolicyDigest, planDigest: grant.planDigest,
    executionLimits: { ...limits, reservedBudgetCents: grant.slice.budgetCents },
  };
}

/** Runs exactly one owner-bound slice. Restart reconciliation runs before claims and never reexecutes a used lease. */
export async function runApprovedWorkerService(options: ApprovedWorkerServiceOptions, deps: ApprovedWorkerServiceDependencies): Promise<ApprovedWorkerServiceResult> {
  const now = options.now ?? Date.now;
  validateOptions(options, now());
  const task = options.task;
  const target = targetFor(task);
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) throw new Error("Approved worker service was interrupted before reconciliation");

  const persisted = assertDurableTaskBinding(await deps.store.getMission(task.missionId), task);
  const persistedSlice = persisted.slices.find(row => row.id === task.sliceId)!;
  if (persistedSlice.budgetCents > task.maxBudgetCents || persistedSlice.budgetCents < options.minimumSliceBudgetCents) throw new Error("Approved slice reservation does not cover the precomputed worst-case provider cost or exceeds the task ceiling");

  await deps.reconcileInterrupted(target);
  await deps.reconcileRetained(target, persistedSlice.leaseEpoch);
  if (signal.aborted) throw new Error("Approved worker service was interrupted before claim");
  if (Date.parse(task.expiresAt) <= now()) throw new Error("Approved task manifest expired during reconciliation");

  const refreshed = assertDurableTaskBinding(await deps.store.getMission(task.missionId), task);
  const slice = refreshed.slices.find(row => row.id === task.sliceId)!;
  if (!slice) throw new Error("Approved task slice is missing from the durable mission");
  if (slice.status === "verified") return integrateIfExplicit(options, deps, refreshed);
  if (slice.status === "cancel_requested" || (slice.status === "unknown" && refreshed.mission.status === "cancelling")) {
    if (slice.leaseEpoch < 1) return "unknown";
    const settlement = await deps.store.settleCancellationBeforeRuntime?.({
      missionId: task.missionId, sliceId: task.sliceId, leaseEpoch: slice.leaseEpoch,
      controllerRunId: controllerRunIdForApprovedTask(task, slice.leaseEpoch),
    });
    if (settlement === "quarantined") return "unknown";
    const afterSettlement = assertDurableTaskBinding(await deps.store.getMission(task.missionId), task);
    const settledSlice = afterSettlement.slices.find(row => row.id === task.sliceId)!;
    if (settledSlice.status === "cancelled") return "cancelled";
    if (settledSlice.status === "unknown") return "unknown";
    if (settledSlice.status === "cancel_requested") return "idle";
    return settledSlice.status === "failed" ? "failed" : "idle";
  }
  if (slice.status === "awaiting_verification") {
    const existingCerts = await Promise.all(slice.checks.map(checkId => deps.trustedChecks.getCertificate(task.missionId, task.sliceId, checkId)));
    if (existingCerts.every(Boolean)) return integrateIfExplicit(options, deps, refreshed);
    const eligible = await deps.store.isVerificationDispatchEligible?.(task.missionId, task.sliceId, slice.leaseEpoch, slice.checks);
    if (!eligible) return "unknown";
    await deps.trustedChecks.verifySlice(task.missionId, task.sliceId);
    const reconciled = await deps.store.getMission(task.missionId);
    const result = reconciled?.slices.find(row => row.id === task.sliceId);
    if (result?.status === "verified") return integrateIfExplicit(options, deps, assertDurableTaskBinding(reconciled, task));
    if (result?.status === "failed" || result?.status === "unknown") return result.status;
    const postVerifyCerts = await Promise.all(slice.checks.map(checkId => deps.trustedChecks.getCertificate(task.missionId, task.sliceId, checkId)));
    return postVerifyCerts.every(Boolean) && reconciled ? integrateIfExplicit(options, deps, assertDurableTaskBinding(reconciled, task)) : "awaiting_verification";
  }
  // Running, cancelled, unknown, or otherwise terminal leases are never restarted as builder work.
  if (slice.status !== "ready") return slice.status === "cancelled" ? "cancelled" : slice.status === "failed" ? "failed" : slice.status === "unknown" ? "unknown" : slice.status === "blocked" ? "blocked" : "idle";
  if (signal.aborted) throw new Error("Approved worker service was interrupted before claim");

  const grant = await deps.governor.claimApproved(target);
  if (!grant) return "idle";
  if (grant.mission.id !== target.missionId || grant.slice.id !== target.sliceId || grant.mission.repository !== target.repository || grant.mission.baseSha !== target.baseSha || grant.planDigest !== target.planDigest || grant.trustedCheckPolicyDigest !== task.trustedCheckPolicyDigest || grant.slice.budgetCents < options.minimumSliceBudgetCents || grant.slice.budgetCents > target.maxBudgetCents) throw new Error("Targeted Governor claim returned a grant outside the approved binding");
  const lease = workerLease(grant, options.executionLimits);
  const laneResult = await deps.executeLane(lease, task, signal);
  if (laneResult !== "verified" && laneResult !== "awaiting_verification") return laneResult;
  const completed = await deps.store.getMission(task.missionId);
  if (!completed) return "unknown";
  return integrateIfExplicit(options, deps, assertDurableTaskBinding(completed, task));
}

async function integrateIfExplicit(options: ApprovedWorkerServiceOptions, deps: ApprovedWorkerServiceDependencies, record: PersistedMission): Promise<ApprovedWorkerServiceResult> {
  const request = options.integrationRequest;
  if (!request) return "awaiting_review";
  if (!deps.integrationAuthority || !deps.prepareCertifiedIntegration) throw new Error("Explicit integration request lacks trusted integration authority or certified artifact preparation");
  if (options.deliveryCommand && (!deps.deliveryPolicy || !deps.deliveryAuthority)) throw new Error("Explicit delivery command lacks controller-owned delivery policy or authority");
  if (request.version !== "orloom.integration-request.v1" || request.missionId !== options.task.missionId || request.sliceId !== options.task.sliceId) throw new Error("Integration request does not match the approved task");
  const slice = record.slices.find(row => row.id === request.sliceId);
  if (!slice || !["verified", "awaiting_verification"].includes(slice.status) || !slice.candidateSha || request.candidateSha !== slice.candidateSha || request.leaseEpoch !== slice.leaseEpoch || canonicalJson([...request.requiredCheckIds].sort()) !== canonicalJson([...slice.checks].sort())) return "unknown";
  const prior = await deps.store.getIntegrationIntent?.(request);
  if (prior?.state === "unknown") return "unknown";
  if (prior?.state !== "integrated") {
    if (slice.status === "verified") return "awaiting_review";
    const certs = await Promise.all(request.requiredCheckIds.map(checkId => deps.trustedChecks.getCertificate(request.missionId, request.sliceId, checkId)));
    if (certs.some(cert => !cert)) throw new Error("Independent exact-slice certificates are unavailable for integration");
    await deps.prepareCertifiedIntegration(record, request);
  }
  await deps.governor.integrateVerifiedSlice(request, deps.trustedChecks, deps.integrationAuthority);
  if (options.deliveryCommand) {
    const command = options.deliveryCommand;
    if (command.missionId !== request.missionId || command.sliceId !== request.sliceId || command.leaseEpoch !== request.leaseEpoch || command.integratedSha !== request.candidateSha || command.reviewArtifactId !== request.reviewArtifactId || command.reviewArtifactDigest !== request.reviewArtifactDigest) throw new Error("Delivery command differs from the explicit certified integration request");
    await deps.governor.deliverIntegratedCommit(command, deps.deliveryPolicy!, deps.deliveryAuthority!);
    return "delivered";
  }
  return "verified";
}
