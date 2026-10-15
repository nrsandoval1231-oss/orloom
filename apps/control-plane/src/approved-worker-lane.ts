import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/judgment/src/canonical.js";
import { executeLease, validateLease, type ControlPlane, type DeepSeekClient, type WorkerEvidence, type WorkerOptions, type WorkerProgressSink, type WorkerRuntime } from "../../../packages/agents/src/worker.js";
import type { MissionStore, SliceInput } from "../../../packages/contracts/src/mission.js";
import type { WorkerLeaseContract } from "../../../packages/contracts/src/worker-protocol.js";
import type { TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";
import { controllerRunIdFor, DockerWorkerRuntime, type DockerWorkerRuntimeOptions } from "../../worker/src/docker-runtime.js";
import { TrustedRuntimeJournalBridge } from "./trusted-runtime-journal-bridge.js";

export interface ApprovedWorkerBinding {
  readonly missionId: string;
  readonly slice: SliceInput;
  readonly baseSha: string;
  readonly planDigest: string;
  readonly trustedCheckPolicyDigest: string;
}

export interface ApprovedWorkerLaneDependencies {
  readonly store: MissionStore;
  readonly binding: ApprovedWorkerBinding;
  readonly control: ControlPlane;
  readonly provider: DeepSeekClient;
  readonly createRuntime: (journal: TrustedRuntimeJournalBridge) => WorkerRuntime;
  readonly evidence: WorkerEvidence;
  readonly progress: WorkerProgressSink;
  readonly checks: Record<string, readonly string[]>;
  readonly options: WorkerOptions;
  readonly trustedChecks: TrustedCheckCoordinator;
  readonly runtimeJournal: TrustedRuntimeJournalBridge;
  readonly now?: () => number;
}

export type ApprovedDockerWorkerLaneDependencies = Omit<ApprovedWorkerLaneDependencies, "createRuntime"> & {
  readonly runtimeOptions: Omit<DockerWorkerRuntimeOptions, "runtimeJournal" | "checkoutTransport">;
};

export type ApprovedWorkerLaneResult = "awaiting_verification" | "verified" | "failed" | "unknown" | "blocked" | "cancelled";

function equal(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
const activeLeases = new Set<string>();

/** Executes one owner-approved, immutable slice exactly once, then delegates final checks to the trusted coordinator. */
export async function runApprovedWorkerLane(input: unknown, deps: ApprovedWorkerLaneDependencies): Promise<ApprovedWorkerLaneResult> {
  const lease = validateLease(input, (deps.now ?? Date.now)());
  const key = `${lease.mission.id}:${lease.slice.id}:${lease.leaseEpoch}`;
  if (activeLeases.has(key)) throw new Error("Approved worker lane refused execution: this lease is already active");
  activeLeases.add(key);
  try { return await runApprovedWorkerLaneOnce(lease, deps); }
  finally { activeLeases.delete(key); }
}

/** Production-shaped composition: the Docker runtime always receives the trusted controller journal bridge. */
export function runApprovedDockerWorkerLane(input: unknown, deps: ApprovedDockerWorkerLaneDependencies): Promise<ApprovedWorkerLaneResult> {
  const { runtimeOptions, ...common } = deps;
  return runApprovedWorkerLane(input, {
    ...common,
    createRuntime: journal => new DockerWorkerRuntime({ ...runtimeOptions, runtimeJournal: journal }),
  });
}

async function runApprovedWorkerLaneOnce(input: WorkerLeaseContract, deps: ApprovedWorkerLaneDependencies): Promise<ApprovedWorkerLaneResult> {
  const lease = validateLease(input, (deps.now ?? Date.now)());
  const { binding, store } = deps;
  const fail = (message: string): never => { throw new Error(`Approved worker lane refused execution: ${message}`); };

  if (lease.mission.id !== binding.missionId || lease.mission.baseSha !== binding.baseSha) fail("lease mission/base differs from the approved binding");
  if (lease.planDigest !== binding.planDigest || lease.trustedCheckPolicyDigest !== binding.trustedCheckPolicyDigest) fail("lease plan/check policy differs from the approved binding");
  const leasedSlice = { id: lease.slice.id, objective: lease.slice.objective, dependencies: lease.slice.dependencies, owner: lease.slice.owner, scopes: lease.slice.scopes, checks: lease.slice.checks };
  const expectedLeaseSlice = { id: binding.slice.id, objective: binding.slice.objective, dependencies: binding.slice.dependencies, owner: binding.slice.owner, scopes: binding.slice.scopes, checks: binding.slice.checks };
  if (!equal(leasedSlice, expectedLeaseSlice)) fail("lease slice differs from the approved slice");
  if (lease.slice.checks.length !== 1 || binding.slice.checks.length !== 1) fail("the approved slice must bind exactly one trusted check");

  const record = await store.getMission(binding.missionId);
  if (!record || !record.plan || !record.plan.approvedAt || record.mission.baseSha !== binding.baseSha || record.plan.missionId !== binding.missionId) fail("persisted approved mission plan is unavailable");
  const approvedRecord = record!;
  if (lease.mission.repository !== approvedRecord.mission.repository || lease.mission.objective !== approvedRecord.mission.objective || !equal(lease.mission.acceptance, approvedRecord.mission.acceptance)) fail("lease mission content differs from durable mission");
  const plan = approvedRecord.plan!;
  if (plan.slices.length !== 1 || !equal(plan.slices[0], binding.slice)) fail("persisted approved plan is not the exact single-slice binding");
  const digest = createHash("sha256").update(canonicalJson(plan.slices)).digest("hex");
  if (digest !== binding.planDigest) fail("persisted plan digest changed");
  const slice = approvedRecord.slices.find(row => row.id === binding.slice.id);
  if (!slice || slice.status !== "running" || slice.leaseEpoch !== lease.leaseEpoch || slice.candidateSha !== null) fail("slice is not the exact live, unused lease");
  if (lease.executionLimits.reservedBudgetCents !== slice!.budgetCents) fail("lease budget differs from approved slice reservation");
  try { await store.heartbeat(lease.mission.id, lease.slice.id, lease.leaseEpoch, lease.leaseToken, lease.capabilityToken, 300); }
  catch { fail("persisted lease credentials or expiry are invalid"); }

  // executeLease is the sole builder executor; the coordinator is reached only after durable submission.
  await executeLease(lease as WorkerLeaseContract, {
    control: deps.control, provider: deps.provider, runtime: deps.createRuntime(deps.runtimeJournal), evidence: deps.evidence,
    progress: deps.progress, checks: deps.checks, options: deps.options, ...(deps.now ? { now: deps.now } : {}),
  });

  await deps.runtimeJournal.reconcileRetained(controllerRunIdFor(lease));
  const after = await store.getMission(binding.missionId);
  const completed = after?.slices.find(row => row.id === binding.slice.id);
  if (!completed) return "unknown";
  if (completed.status === "cancel_requested") {
    await store.settleCancellationBeforeRuntime?.({ missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, controllerRunId: controllerRunIdFor(lease) });
    const settled = await store.getMission(binding.missionId);
    if (settled?.slices.find(row => row.id === binding.slice.id)?.status === "cancelled") return "cancelled";
  }
  if (completed.status === "awaiting_verification" && completed.candidateSha) {
    await deps.trustedChecks.verifySlice(binding.missionId, binding.slice.id);
    const verified = await store.getMission(binding.missionId);
    const finalSlice = verified?.slices.find(row => row.id === binding.slice.id);
    if (finalSlice?.status === "verified") return "verified";
    if (finalSlice?.status === "failed") return "failed";
    if (finalSlice?.status === "unknown") return "unknown";
    return "awaiting_verification";
  }
  if (completed.status === "failed") return "failed";
  if (completed.status === "unknown") return "unknown";
  if (completed.status === "cancelled") return "cancelled";
  if (completed.status === "blocked") return "blocked";
  return "unknown";
}
