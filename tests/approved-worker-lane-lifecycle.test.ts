import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { runApprovedWorkerLane } from "../apps/control-plane/src/approved-worker-lane.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";
import type { MissionStore } from "../packages/contracts/src/mission.js";
import type { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import type { RuntimeJournal } from "../apps/worker/src/runtime-journal.js";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("lane signal abort after reconciled mission readback fences verifier dispatch without an explicit lifecycle guard", async () => {
  const missionId = "123e4567-e89b-12d3-a456-426614174000", sliceId = "only", baseSha = "a".repeat(40), candidateSha = "b".repeat(40);
  const policyDigest = hash(JSON.stringify(["check:fixture"]));
  const planSlice = { id: sliceId, objective: "bounded edit", dependencies: [] as string[], owner: "owner", scopes: ["src/file.ts"], checks: ["check:fixture"], budgetCents: 100 };
  const planDigest = hash(canonicalJson([planSlice]));
  const record = {
    mission: { id: missionId, repository: "owner/repo", baseSha, objective: "fixture", acceptance: ["one change"], budgetCents: 100, reservedCents: 100, status: "running", createdAt: new Date().toISOString() },
    plan: { missionId, slices: [planSlice], recommendedBy: "owner", recommendedAt: new Date().toISOString(), approvedAt: new Date().toISOString() },
    slices: [{ ...planSlice, missionId, status: "running", leaseEpoch: 1, leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), candidateSha: null, evidenceRefs: [] }],
  };
  const lease: WorkerLeaseContract = { protocol: "orloom.worker-lease.v1", mission: { id: missionId, repository: "owner/repo", baseSha, objective: "fixture", acceptance: ["one change"] }, slice: planSlice, capacitySlot: 1, leaseEpoch: 1, leaseToken: "lease", capabilityToken: "capability", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), planDigest, trustedCheckPolicyDigest: policyDigest, executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 2, maxInputTokens: 100_000, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: ["fixture-model"] } };
  const controller = new AbortController(); let missionReads = 0, verifyCalls = 0;
  const store = {
    async getMission() { missionReads++; const value = record; if (missionReads === 2) controller.abort(); return value; },
    async heartbeat() {},
    async registerCancellationRuntimeBinding() {}, async bindCancellationRuntimeContainer() {}, async reconcileCancellationRuntime() { return "settled" as const; },
  } as unknown as MissionStore;
  const runtimeJournal: RuntimeJournal = { recordIntent: async () => {}, recordCreated: async () => {}, recordUnknown: async () => {}, recordAbsent: async () => {}, unresolved: async () => [], entries: async () => [] };
  const artifacts = new Map<string, Uint8Array>();
  const checks = { "check:fixture": ["node"] };
  const command = { executable: "node", args: ["fixture"], timeoutSeconds: 10 };
  const workerOptions = { allowedModels: ["fixture-model"], allowedProviders: ["deepseek"], trustedChecks: planSlice.checks, trustedCheckPolicyDigest: policyDigest, trustedCheckCommands: { "check:fixture": command }, sandboxImageRef: `sha256:${"d".repeat(64)}`, maxToolCalls: 1, pricing: { model: "fixture-model", version: "fixture", source: "test", capturedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), inputCentsPerMillion: 1, outputCentsPerMillion: 1, reasoningCentsPerMillion: 1, safetyMultiplier: 1.25 } };
  const pending = runApprovedWorkerLane(lease, {
    store, binding: { missionId, slice: planSlice, baseSha, planDigest, trustedCheckPolicyDigest: policyDigest }, signal: controller.signal,
    control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, output) { assert("candidateSha" in output); Object.assign(record.slices[0]!, { status: "awaiting_verification", candidateSha: output.candidateSha }); } },
    provider: { async listModels() { return ["fixture-model"]; }, async probeTools(model) { return { model, inputTokens: 1, outputTokens: 1 }; }, async complete(model) { return { model, message: { role: "assistant" as const, content: "candidate ready" }, inputTokens: 1, outputTokens: 1 }; } },
    createRuntime: () => ({ create: async () => ({ async checkout() {}, async readFile() { return ""; }, async listFiles() { return []; }, async replaceText() {}, async runCheck() { throw new Error("unused"); }, async commitCandidate() { return { candidateSha, diff: Buffer.from("diff"), bundle: Buffer.from("bundle") }; }, async close() {} }) }),
    evidence: { async put(bytes) { const key = `sha256/${hash(bytes)}`; artifacts.set(key, Buffer.from(bytes)); return { key, sha256: hash(bytes) }; }, async get(key) { return artifacts.get(key)!; } },
    progress: { async append(_lease, event) { return { decision: "CONTINUE" as const, reference: `sha256/${event.eventId}:${event.eventId}`, digest: event.eventId }; } }, checks, options: workerOptions,
    trustedChecks: { async verifySlice() { verifyCalls++; } } as unknown as TrustedCheckCoordinator,
    runtimeJournal: new TrustedRuntimeJournalBridge(runtimeJournal, store),
  });
  await assert.rejects(pending, /aborted/i);
  assert.equal(missionReads, 2);
  assert.equal(verifyCalls, 0, "signal abort at the durable post-runtime readback must stop before starting verification");
});
