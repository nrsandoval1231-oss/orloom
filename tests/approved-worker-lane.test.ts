import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";
import type { RuntimeJournal, RuntimeJournalEntry } from "../apps/worker/src/runtime-journal.js";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";
import { runApprovedDockerWorkerLane, runApprovedWorkerLane } from "../apps/control-plane/src/approved-worker-lane.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import type { WorkerResult } from "../packages/contracts/src/worker-protocol.js";
import type { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("approved worker lane refuses changed binding before executeLease and runs exact one-slice lifecycle once", async () => {
  const store = new MemoryMissionStore();
  const policyDigest = hash(JSON.stringify(["check:fixture"]));
  const baseSha = "a".repeat(40);
  await store.configureCapacity(1, hash("capacity"), new Date(Date.now() + 120_000).toISOString());
  const mission = await store.submit({ repository: "owner/repo", baseSha, objective: "fixture", acceptance: ["one bounded change"], budgetCents: 100 });
  const slice = { id: "only", objective: "make the bounded change", dependencies: [], owner: "owner", scopes: ["src/file.ts"], checks: ["check:fixture"], budgetCents: 100 };
  await store.recommendPlan(mission.id, [slice], "owner-session");
  await store.approvePlan(mission.id);
  const grant = await store.claim(300, policyDigest, slice.checks);
  assert(grant);
  const lease: WorkerLeaseContract = {
    protocol: "orloom.worker-lease.v1", mission: { id: mission.id, repository: mission.repository, baseSha, objective: mission.objective, acceptance: mission.acceptance },
    slice: { id: slice.id, objective: slice.objective, dependencies: [], owner: slice.owner, scopes: slice.scopes, checks: slice.checks },
    capacitySlot: grant.capacitySlot, leaseEpoch: grant.epoch, leaseToken: grant.leaseToken, capabilityToken: grant.capabilityToken,
    leaseExpiresAt: grant.leaseExpiresAt, trustedCheckPolicyDigest: policyDigest, planDigest: grant.planDigest,
    executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 2, maxInputTokens: 100_000, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: ["fixture-model"] },
  };
  const binding = { missionId: mission.id, slice, baseSha, planDigest: grant.planDigest, trustedCheckPolicyDigest: policyDigest };
  const emptyJournal: RuntimeJournal = {
    recordIntent: async () => {}, recordCreated: async () => {}, recordUnknown: async () => {}, recordAbsent: async () => {},
    unresolved: async () => [], entries: async () => [],
  };
  const runtimeJournal = new TrustedRuntimeJournalBridge(emptyJournal, store);
  let providerCalls = 0, executeResults = 0, verificationCalls = 0;
  let markProviderStarted!: () => void, releaseProvider!: () => void;
  const providerStarted = new Promise<void>(resolve => { markProviderStarted = resolve; });
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  const artifacts = new Map<string, Uint8Array>();
  const checkCommand = { executable: "node", args: ["fixture"], timeoutSeconds: 10 };
  const options = {
    allowedModels: ["fixture-model"], allowedProviders: ["deepseek"], trustedChecks: slice.checks, trustedCheckPolicyDigest: policyDigest,
    trustedCheckCommands: { "check:fixture": checkCommand }, sandboxImageRef: `sha256:${"d".repeat(64)}`, maxToolCalls: 2,
    pricing: { model: "fixture-model", version: "fixture", source: "test", capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), inputCentsPerMillion: 1, outputCentsPerMillion: 1, reasoningCentsPerMillion: 1, safetyMultiplier: 1.25 },
  };
  const deps = {
    store, binding, runtimeJournal, options,
    control: {
      claim: async () => null, heartbeat: async () => {}, result: async (_lease: WorkerLeaseContract, result: WorkerResult) => {
        executeResults++;
        assert("candidateSha" in result);
        await store.complete(mission.id, slice.id, grant.epoch, grant.leaseToken, grant.capabilityToken, result.candidateSha, []);
      },
    },
    provider: {
      listModels: async () => { markProviderStarted(); await providerGate; return ["fixture-model"]; }, probeTools: async () => { providerCalls++; return { model: "fixture-model", inputTokens: 1, outputTokens: 1 }; },
      complete: async () => { providerCalls++; return { model: "fixture-model", message: { role: "assistant" as const, content: null }, inputTokens: 1, outputTokens: 1 }; },
    },
    createRuntime: () => ({ create: async () => ({
      checkout: async () => {}, readFile: async () => "", listFiles: async () => [], createFile: async () => {}, replaceText: async () => {},
      runCheck: async () => ({ exitCode: 0, output: "", outputSha256: hash(""), commandDigest: hash("cmd"), durationMs: 1, imageRef: `sha256:${"d".repeat(64)}` }),
      commitCandidate: async () => ({ candidateSha: "b".repeat(40), diff: new TextEncoder().encode("diff"), bundle: new TextEncoder().encode("bundle") }), close: async () => {},
    }) }),
    evidence: {
      put: async (bytes: Uint8Array) => { const key = `sha256/${hash(bytes)}`; artifacts.set(key, bytes); return { key, sha256: hash(bytes) }; },
      get: async (key: string) => artifacts.get(key)!,
    },
    progress: { append: async (_lease: unknown, event: { eventId: string }) => ({ decision: "CONTINUE" as const, reference: `sha256/${event.eventId}:${event.eventId}`, digest: event.eventId }) },
    checks: { "check:fixture": ["node"] },
    trustedChecks: { verifySlice: async () => { verificationCalls++; } } as unknown as TrustedCheckCoordinator,
  };
  // Binding mismatch is rejected before provider/runtime execution.
  await assert.rejects(runApprovedWorkerLane(lease, { ...deps, binding: { ...binding, baseSha: "c".repeat(40) } }), /base differs/);
  await assert.rejects(runApprovedWorkerLane({ ...lease, mission: { ...lease.mission, repository: "other/repo" } }, deps), /mission content/);
  await assert.rejects(runApprovedWorkerLane({ ...lease, executionLimits: { ...lease.executionLimits, reservedBudgetCents: 99 } }, deps), /budget differs/);
  await assert.rejects(runApprovedWorkerLane({ ...lease, leaseToken: "forged-token" }, deps), /credentials or expiry/);
  const { createRuntime: _fixtureFactory, ...concreteDeps } = deps;
  await assert.rejects(runApprovedDockerWorkerLane(lease, {
    ...concreteDeps,
    binding: { ...binding, baseSha: "c".repeat(40) },
    runtimeOptions: { imageRef: `sha256:${"d".repeat(64)}`, installationId: 1, checkoutTokens: { createCheckoutToken: async () => "unused" }, checks: {} },
  }), /base differs/);
  assert.equal(providerCalls, 0);
  assert.equal(executeResults, 0);

  const running = runApprovedWorkerLane(lease, deps);
  await providerStarted;
  await assert.rejects(runApprovedWorkerLane(lease, deps), /already active/);
  releaseProvider();
  const result = await running;
  assert.equal(result, "awaiting_verification");
  assert.equal(providerCalls, 2);
  assert.equal(executeResults, 1);
  assert.equal(verificationCalls, 1);
  assert.equal((await store.getMission(mission.id))?.slices[0]?.status, "awaiting_verification");
  assert.equal(hash(canonicalJson([slice])).length, 64);
});
