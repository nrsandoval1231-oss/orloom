import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { controllerRunIdForApprovedTask, reconcileApprovedWorkerRetained, runApprovedWorkerService, type ApprovedClaimTarget, type ApprovedWorkerServiceDependencies, type ApprovedWorkerServiceOptions } from "../apps/worker/src/approved-service.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import type { MissionStore } from "../packages/contracts/src/mission.js";
import type { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

const planSlice = { id: "slice-one", objective: "bounded change", dependencies: [] as string[], owner: "builder", scopes: ["src/**"], checks: ["node-repo-suite-v1"], budgetCents: 100 };
const task = { missionId: "123e4567-e89b-12d3-a456-426614174000", sliceId: "slice-one", repository: "owner/repo", baseSha: "a".repeat(40), planDigest: createHash("sha256").update(canonicalJson([planSlice])).digest("hex"), trustedCheckPolicyDigest: "c".repeat(64), maxBudgetCents: 100, expiresAt: new Date(Date.now() + 60_000).toISOString() };
const limits = { reservedBudgetCents: 100, maxProviderCalls: 6, maxInputTokens: 50_000, maxOutputTokens: 10_000, maxWallSeconds: 180, allowedProviders: ["deepseek"], allowedModels: ["deepseek-chat"] };
const options: ApprovedWorkerServiceOptions = { task, executionLimits: limits, minimumSliceBudgetCents: 50, leaseSeconds: 300 };
const mission = { id: task.missionId, repository: task.repository, baseSha: task.baseSha, objective: "approved work", acceptance: ["done"], budgetCents: 100, reservedCents: 100, status: "ready" as const, createdAt: new Date().toISOString() };
const slice = { id: task.sliceId, missionId: task.missionId, objective: "bounded change", dependencies: [], owner: "builder", scopes: ["src/**"], checks: ["node-repo-suite-v1"], budgetCents: 100, status: "ready" as const, leaseEpoch: 0, leaseToken: null, leaseExpiresAt: null, candidateSha: null, evidenceRefs: [] };
const grant = { mission, slice: { ...slice, status: "running" as const, leaseEpoch: 1, leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, epoch: 1, leaseToken: "lease", capabilityToken: "capability", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), capacitySlot: 1, trustedCheckPolicyDigest: task.trustedCheckPolicyDigest, planDigest: task.planDigest };
const runId = (epoch: number) => createHash("sha256").update(JSON.stringify(["orloom.worker-lease.v1", task.missionId, task.sliceId, epoch, task.planDigest, task.trustedCheckPolicyDigest])).digest("hex");

function setup(status: string = "ready", hasCertificate = false) {
  const calls: string[] = [];
  const record = { mission: { ...mission }, plan: { missionId: task.missionId, slices: [planSlice], recommendedBy: "owner", recommendedAt: new Date().toISOString(), approvedAt: new Date().toISOString() }, slices: [{ ...slice, status, leaseEpoch: ["awaiting_verification", "cancel_requested"].includes(status) ? 1 : 0 }] };
  const store = { async getMission() { return record; }, async isVerificationDispatchEligible(missionId: string, sliceId: string, epoch: number, checkIds: readonly string[]) { calls.push("eligible"); assert.equal(missionId, task.missionId); assert.equal(sliceId, task.sliceId); assert.equal(epoch, 1); assert.deepEqual(checkIds, planSlice.checks); return status === "awaiting_verification"; }, async awaitingVerification() { throw new Error("approved service must not scan the global verifier backlog"); } } as unknown as MissionStore;
  const governor = { async claimApproved(target: ApprovedClaimTarget) { calls.push("claim"); assert.deepEqual(target, { missionId: task.missionId, sliceId: task.sliceId, repository: task.repository, baseSha: task.baseSha, planDigest: task.planDigest, maxBudgetCents: 100 }); return grant; } } as unknown as MissionGovernor;
  const trustedChecks = { async verifySlice() { calls.push("verify"); }, async getCertificate() { return hasCertificate ? { certificateId: "fixture-certificate" } : null; } } as unknown as TrustedCheckCoordinator;
  const deps: ApprovedWorkerServiceDependencies = {
    store, governor, trustedChecks,
    async reconcileInterrupted(target) { calls.push("interrupted"); assert.equal(target.sliceId, task.sliceId); },
    async reconcileRetained(target) { calls.push("retained"); assert.equal(target.sliceId, task.sliceId); },
    async executeLane(lease: WorkerLeaseContract, binding, signal) { calls.push("execute"); assert.equal(lease.slice.id, task.sliceId); assert.equal(binding.planDigest, task.planDigest); assert.equal(signal.aborted, false); return "verified"; },
  };
  return { calls, deps, record };
}

test("approved service reconciles first, claims the exact binding once, and executes once", async () => {
  const { calls, deps } = setup();
  assert.equal(await runApprovedWorkerService(options, deps), "awaiting_review");
  assert.deepEqual(calls, ["interrupted", "retained", "claim", "execute"]);
});

test("restart verification does not claim or execute already running or awaiting work", async () => {
  const running = setup("running");
  assert.equal(await runApprovedWorkerService(options, running.deps), "idle");
  assert.deepEqual(running.calls, ["interrupted", "retained"]);
  const awaiting = setup("awaiting_verification");
  assert.equal(await runApprovedWorkerService(options, awaiting.deps), "awaiting_verification");
  assert.deepEqual(awaiting.calls, ["interrupted", "retained", "eligible", "verify"]);
});

test("owner cancellation without a runtime binding settles using the exact run identity", async () => {
  const { calls, deps: base, record } = setup("cancel_requested");
  record.mission.status = "cancelling" as never;
  let identity: unknown;
  const deps = { ...base, store: {
    ...base.store,
    async settleCancellationBeforeRuntime(value: unknown) { identity = value; record.slices[0]!.status = "cancelled" as never; record.mission.status = "cancelled" as never; return "settled" as const; },
    async getMission() { return record; },
  } as unknown as MissionStore };
  assert.equal(await runApprovedWorkerService(options, deps), "cancelled");
  assert.deepEqual(identity, { missionId: task.missionId, sliceId: task.sliceId, leaseEpoch: 1, controllerRunId: runId(1) });
  assert.deepEqual(calls, ["interrupted", "retained"]);
});

test("cancel_requested with a bound runtime remains quarantined and cannot claim", async () => {
  const { calls, deps: base, record } = setup("cancel_requested");
  record.mission.status = "cancelling" as never;
  let identity: unknown;
  const deps = { ...base, store: {
    ...base.store,
    async settleCancellationBeforeRuntime(value: unknown) { identity = value; return "quarantined" as const; },
    async getMission() { return record; },
  } as unknown as MissionStore };
  assert.equal(await runApprovedWorkerService(options, deps), "unknown");
  assert.deepEqual(identity, { missionId: task.missionId, sliceId: task.sliceId, leaseEpoch: 1, controllerRunId: runId(1) });
  assert.deepEqual(calls, ["interrupted", "retained"]);
});

test("main retained-runtime callback accepts only settlement or validated normal ABSENT", async () => {
  const target = { missionId: task.missionId, sliceId: task.sliceId, repository: task.repository, baseSha: task.baseSha, planDigest: task.planDigest, maxBudgetCents: task.maxBudgetCents };
  let observed: unknown;
  const exactRunId = controllerRunIdForApprovedTask(task, 1);
  await reconcileApprovedWorkerRetained({ async reconcileRetained(controllerRunId, selected) { observed = { controllerRunId, selected }; return ["observed_absent"]; } }, target, exactRunId);
  assert.deepEqual(observed, { controllerRunId: exactRunId, selected: { missionId: task.missionId, sliceId: task.sliceId } });
  await reconcileApprovedWorkerRetained({ async reconcileRetained() { return ["settled"]; } }, target, exactRunId);
  for (const outcome of ["ignored", "quarantined"] as const) {
    await assert.rejects(reconcileApprovedWorkerRetained({ async reconcileRetained() { return [outcome]; } }, target, exactRunId), /malformed, stale, or quarantined/);
  }
});

test("interruption before reconciliation cannot reach claim", async () => {
  const { calls, deps } = setup();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runApprovedWorkerService({ ...options, signal: controller.signal }, deps), /interrupted before reconciliation/);
  assert.deepEqual(calls, []);
});

test("actual approved reservation must cover precomputed worst-case cost before reconciliation or claim", async () => {
  const { calls, deps } = setup();
  await assert.rejects(runApprovedWorkerService({ ...options, task: { ...task, maxBudgetCents: 200 }, minimumSliceBudgetCents: 101 }, deps), /does not cover/);
  assert.deepEqual(calls, []);
});

test("settlement replay refreshes task status before any claim or execution", async () => {
  const { calls, deps: base, record } = setup("running");
  const deps = { ...base, async reconcileRetained() { calls.push("retained"); record.slices[0]!.status = "cancelled"; } };
  assert.equal(await runApprovedWorkerService(options, deps), "cancelled");
  assert.deepEqual(calls, ["interrupted", "retained"]);
});

test("explicit review request integrates the awaiting candidate only after certificate preparation", async () => {
  const { calls, deps: base, record } = setup("awaiting_verification", true);
  const mutableRecord = record as { slices: Array<{ candidateSha: string | null; leaseEpoch: number }> };
  mutableRecord.slices[0]!.candidateSha = "d".repeat(40);
  mutableRecord.slices[0]!.leaseEpoch = 1;
  const deps = {
    ...base,
    integrationAuthority: {} as never,
    async prepareCertifiedIntegration() { calls.push("prepare"); },
    governor: { ...base.governor, async integrateVerifiedSlice() { calls.push("integrate"); } } as unknown as MissionGovernor,
  };
  const integrationRequest = { version: "orloom.integration-request.v1" as const, missionId: task.missionId, sliceId: task.sliceId, expectedIntegrationSha: task.baseSha, candidateSha: "d".repeat(40), leaseEpoch: 1, requiredCheckIds: ["node-repo-suite-v1"], reviewArtifactId: "review-fixture", reviewArtifactDigest: "e".repeat(64) };
  assert.equal(await runApprovedWorkerService({ ...options, integrationRequest }, deps), "verified");
  assert.deepEqual(calls, ["interrupted", "retained", "prepare", "integrate"]);
});
