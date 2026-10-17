import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import { LifecycleStoppedError, type LifecycleGuard } from "../packages/contracts/src/lifecycle.js";
import type { MissionStore } from "../packages/contracts/src/mission.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missionId = "123e4567-e89b-12d3-a456-426614174000", sliceId = "slice", candidateSha = "a".repeat(40), checkId = "check:unit";
const planSlice = { id: sliceId, objective: "fixture", dependencies: [] as string[], owner: "owner", scopes: ["src"], checks: [checkId], budgetCents: 100 };
const record = { mission: { id: missionId, repository: "owner/repo", baseSha: "b".repeat(40), objective: "fixture", acceptance: ["done"], budgetCents: 100, reservedCents: 100, status: "running", createdAt: new Date().toISOString() }, plan: { missionId, slices: [planSlice], recommendedBy: "owner", recommendedAt: new Date().toISOString(), approvedAt: new Date().toISOString() }, slices: [{ ...planSlice, missionId, status: "awaiting_verification", leaseEpoch: 1, leaseToken: null, leaseExpiresAt: null, candidateSha, evidenceRefs: [] }] };
const settings = { imageDigest: "c".repeat(64), verifierId: "fixture-verifier", policyDigest: "d".repeat(64), leasePolicyDigest: "e".repeat(64), policyVersion: "fixture-v1", allowedChecks: [checkId], attemptLifetimeMs: 60_000 };

function guardFor(controller: AbortController): LifecycleGuard { return async () => { if (controller.signal.aborted) throw new LifecycleStoppedError(); }; }

test("trusted coordinator fences attempt creation when preparation is interrupted", async () => {
  const controller = new AbortController(); let attempts = 0;
  const store = { async getMission() { return record; }, async createVerificationAttempt() { attempts++; }, async submitVerification() { throw new Error("must not submit"); } } as unknown as MissionStore;
  const runner = { async prepareBundle() { controller.abort(); return { digest: "f".repeat(64), manifest: Buffer.from("bundle"), files: new Map<string, Buffer>() }; }, async observeHead() { return { sha: candidateSha, observedAt: new Date().toISOString(), digest: "1".repeat(64) }; }, async run() { throw new Error("must not run"); }, async verifyArtifacts() { return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), manifest: Buffer.alloc(0) }; } };
  const coordinator = new TrustedCheckCoordinator(store, runner, settings);
  await assert.rejects(coordinator.verifySlice(missionId, sliceId, guardFor(controller)), LifecycleStoppedError);
  assert.equal(attempts, 0, "abort after bundle preparation prevents durable verifier-attempt creation");
});

test("trusted coordinator rejects a suite configuration outside the finite v10 lifetime", () => {
  const store = {} as MissionStore, runner = {} as never;
  assert.throws(() => new TrustedCheckCoordinator(store, runner, {
    ...settings, allowedChecks: ["node-repo-suite-v1"], policyVersion: "orloom.node-repo-suite.v10", attemptLifetimeMs: 1_860_001,
  }), /finite v10 policy/);
});

test("trusted coordinator fences certificate submission when receipt verification is interrupted", async () => {
  const controller = new AbortController(); let attempts = 0, submissions = 0;
  const store = { async getMission() { return record; }, async createVerificationAttempt() { attempts++; }, async submitVerification() { submissions++; return null; } } as unknown as MissionStore;
  const runner = {
    async prepareBundle() { return { digest: "f".repeat(64), manifest: Buffer.from("bundle"), files: new Map<string, Buffer>() }; },
    async observeHead() { return { sha: candidateSha, observedAt: new Date().toISOString(), digest: "1".repeat(64) }; },
    async run(request: unknown) { return { request } as never; },
    async verifyArtifacts() { controller.abort(); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), manifest: Buffer.alloc(0) }; },
  };
  const coordinator = new TrustedCheckCoordinator(store, runner, settings);
  await assert.rejects(coordinator.verifySlice(missionId, sliceId, guardFor(controller)), LifecycleStoppedError);
  assert.equal(attempts, 1, "the verification attempt already created before interruption remains durable");
  assert.equal(submissions, 0, "abort during receipt artifact verification prevents the certificate write");
});
