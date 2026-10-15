import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runApprovedWorkerService } from "../apps/worker/src/approved-service.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import type { MissionStore } from "../packages/contracts/src/mission.js";
import type { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";

const slicePlan = { id: "slice-one", objective: "bounded change", dependencies: [] as string[], owner: "builder", scopes: ["src/**"], checks: ["node-repo-suite-v1"], budgetCents: 100 };
const task = { missionId: "123e4567-e89b-12d3-a456-426614174000", sliceId: slicePlan.id, repository: "owner/repo", baseSha: "a".repeat(40), planDigest: createHash("sha256").update(canonicalJson([slicePlan])).digest("hex"), trustedCheckPolicyDigest: "c".repeat(64), maxBudgetCents: 100, expiresAt: new Date(Date.now() + 60_000).toISOString() };
const options = { task, executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["fixture"], allowedModels: ["fixture"] }, minimumSliceBudgetCents: 1, leaseSeconds: 60 };

function fixture() {
  const calls: string[] = [];
  const record = {
    mission: { id: task.missionId, repository: task.repository, baseSha: task.baseSha, objective: "approved", acceptance: ["done"], budgetCents: 100, reservedCents: 100, status: "ready", createdAt: new Date().toISOString() },
    plan: { missionId: task.missionId, slices: [slicePlan], recommendedBy: "owner", recommendedAt: new Date().toISOString(), approvedAt: new Date().toISOString() },
    slices: [{ ...slicePlan, missionId: task.missionId, status: "awaiting_verification", leaseEpoch: 1, leaseToken: null, leaseExpiresAt: null, candidateSha: "d".repeat(40), evidenceRefs: [] }],
  };
  const store = { async getMission() { return record; }, async isVerificationDispatchEligible() { return true; } } as unknown as MissionStore;
  const controller = new AbortController();
  const deps = {
    store,
    async reconcileInterrupted() {}, async reconcileRetained() {},
    async executeLane() { throw new Error("unexpected builder execution"); },
    trustedChecks: {
      async verifySlice() { calls.push("verify:start"); controller.abort(); calls.push("verify:end"); },
      async getCertificate() { return calls.includes("verify:end") ? { certificateId: "cert" } : null; },
    } as unknown as TrustedCheckCoordinator,
    governor: { async integrateVerifiedSlice() { calls.push("integrate"); } } as unknown as MissionGovernor,
    integrationAuthority: {} as never,
    async prepareCertifiedIntegration() { calls.push("prepare"); },
  };
  const integrationRequest = { version: "orloom.integration-request.v1" as const, missionId: task.missionId, sliceId: task.sliceId, expectedIntegrationSha: task.baseSha, candidateSha: "d".repeat(40), leaseEpoch: 1, requiredCheckIds: slicePlan.checks, reviewArtifactId: "review-fixture", reviewArtifactDigest: "e".repeat(64) };
  return { calls, controller, deps, integrationRequest, record };
}

test("abort while verification runs fences preparation and integration", async () => {
  const f = fixture();
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal, integrationRequest: f.integrationRequest }, f.deps);
  assert.equal(result, "unknown");
  assert.deepEqual(f.calls, ["verify:start", "verify:end"]);
});

test("durable owner cancellation during verification fences preparation and integration", async () => {
  const f = fixture(); const record = f.record as { mission: { status: string }; slices: Array<{ status: string }> };
  const checks = f.deps.trustedChecks as unknown as { verifySlice(): Promise<void> };
  checks.verifySlice = async () => { f.calls.push("verify:start"); record.mission.status = "cancelling"; record.slices[0]!.status = "cancel_requested"; f.calls.push("verify:end"); };
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal, integrationRequest: f.integrationRequest }, f.deps);
  assert.equal(result, "unknown");
  assert.deepEqual(f.calls, ["verify:start", "verify:end"]);
});

test("manifest expiry during verification fences preparation and integration", async () => {
  const f = fixture(); let clock = 1_000;
  const checks = f.deps.trustedChecks as unknown as { verifySlice(): Promise<void> };
  checks.verifySlice = async () => { f.calls.push("verify:start"); clock = 2_000; f.calls.push("verify:end"); };
  const result = await runApprovedWorkerService({ ...options, now: () => clock, task: { ...task, expiresAt: new Date(1_500).toISOString() }, integrationRequest: f.integrationRequest }, f.deps);
  assert.equal(result, "unknown");
  assert.deepEqual(f.calls, ["verify:start", "verify:end"]);
});

test("abort during durable claim preserves reservation and never enters the lane", async () => {
  const f = fixture(); const record = f.record as { mission: { status: string }; slices: Array<{ status: string; leaseEpoch: number; candidateSha: string | null }> };
  record.mission.status = "ready"; record.slices[0]!.status = "ready"; record.slices[0]!.leaseEpoch = 0; record.slices[0]!.candidateSha = null;
  let laneCalls = 0;
  const grant = { mission: record.mission, slice: { ...record.slices[0]!, status: "running", leaseEpoch: 1, leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, epoch: 1, leaseToken: "lease", capabilityToken: "capability", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), capacitySlot: 1, trustedCheckPolicyDigest: task.trustedCheckPolicyDigest, planDigest: task.planDigest };
  const deps = { ...f.deps, governor: { async claimApproved() { f.controller.abort(); return grant; } } as unknown as MissionGovernor, async executeLane() { laneCalls++; return "verified" as const; } };
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal }, deps);
  assert.equal(result, "unknown");
  assert.equal(laneCalls, 0, "the durable claim remains reserved but builder/provider execution never starts");
});

test("abort during certified preparation fences integration", async () => {
  const f = fixture(); const mutable = f.deps as unknown as { trustedChecks: TrustedCheckCoordinator; governor: MissionGovernor; prepareCertifiedIntegration: () => Promise<void> };
  mutable.trustedChecks = { async getCertificate() { return { certificateId: "cert" }; } } as unknown as TrustedCheckCoordinator;
  mutable.prepareCertifiedIntegration = async () => { f.calls.push("prepare:start"); f.controller.abort(); f.calls.push("prepare:end"); };
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal, integrationRequest: f.integrationRequest }, f.deps);
  assert.equal(result, "unknown");
  assert.deepEqual(f.calls, ["prepare:start", "prepare:end"]);
});

test("abort during final certificate readback fences certified preparation", async () => {
  const f = fixture(); const mutable = f.deps as unknown as { trustedChecks: TrustedCheckCoordinator; governor: MissionGovernor; prepareCertifiedIntegration: () => Promise<void> };
  let certificateReads = 0;
  mutable.trustedChecks = { async getCertificate() { if (++certificateReads === 2) f.controller.abort(); return { certificateId: "cert" }; } } as unknown as TrustedCheckCoordinator;
  let prepares = 0, integrations = 0;
  mutable.prepareCertifiedIntegration = async () => { prepares++; };
  mutable.governor = { async integrateVerifiedSlice() { integrations++; } } as unknown as MissionGovernor;
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal, integrationRequest: f.integrationRequest }, f.deps);
  assert.equal(result, "unknown");
  assert.equal(prepares, 0);
  assert.equal(integrations, 0);
});

test("abort during integration fences delivery and cannot report delivered", async () => {
  const f = fixture(); const mutable = f.deps as unknown as { trustedChecks: TrustedCheckCoordinator; governor: MissionGovernor; prepareCertifiedIntegration: () => Promise<void> };
  mutable.trustedChecks = { async getCertificate() { return { certificateId: "cert" }; } } as unknown as TrustedCheckCoordinator;
  mutable.governor = {
    async integrateVerifiedSlice() { f.calls.push("integrate:start"); f.controller.abort(); f.calls.push("integrate:end"); },
    async deliverIntegratedCommit() { f.calls.push("deliver"); },
  } as unknown as MissionGovernor;
  mutable.prepareCertifiedIntegration = async () => { f.calls.push("prepare"); };
  const request = f.integrationRequest;
  const deliveryCommand = { version: "orloom.delivery-command.v1" as const, missionId: request.missionId, sliceId: request.sliceId, leaseEpoch: request.leaseEpoch, integratedSha: request.candidateSha, treeSha: "f".repeat(40), reviewArtifactId: request.reviewArtifactId, reviewArtifactDigest: request.reviewArtifactDigest, idempotencyKey: "approved-worker-fixture-000001" };
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal, integrationRequest: request, deliveryCommand }, { ...f.deps, deliveryPolicy: {} as never, deliveryAuthority: {} as never });
  assert.equal(result, "unknown");
  assert.deepEqual(f.calls, ["prepare", "integrate:start", "integrate:end"]);
});

test("abort during delivery preserves the started effect as unresolved", async () => {
  const f = fixture(); const mutable = f.deps as unknown as { trustedChecks: TrustedCheckCoordinator; governor: MissionGovernor; prepareCertifiedIntegration: () => Promise<void> };
  mutable.trustedChecks = { async getCertificate() { return { certificateId: "cert" }; } } as unknown as TrustedCheckCoordinator;
  mutable.governor = {
    async integrateVerifiedSlice() { f.calls.push("integrate"); },
    async deliverIntegratedCommit() { f.calls.push("delivery:start"); f.controller.abort(); f.calls.push("delivery:end"); throw new Error("remote upload outcome is unresolved"); },
  } as unknown as MissionGovernor;
  mutable.prepareCertifiedIntegration = async () => { f.calls.push("prepare"); };
  const request = f.integrationRequest;
  const deliveryCommand = { version: "orloom.delivery-command.v1" as const, missionId: request.missionId, sliceId: request.sliceId, leaseEpoch: request.leaseEpoch, integratedSha: request.candidateSha, treeSha: "f".repeat(40), reviewArtifactId: request.reviewArtifactId, reviewArtifactDigest: request.reviewArtifactDigest, idempotencyKey: "approved-worker-fixture-000001" };
  const result = await runApprovedWorkerService({ ...options, signal: f.controller.signal, integrationRequest: request, deliveryCommand }, { ...f.deps, deliveryPolicy: {} as never, deliveryAuthority: {} as never });
  assert.equal(result, "unknown");
  assert.deepEqual(f.calls, ["prepare", "integrate", "delivery:start", "delivery:end"]);
});
