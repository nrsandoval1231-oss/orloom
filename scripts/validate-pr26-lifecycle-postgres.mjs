import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresJobStore } from "../dist/packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "../dist/packages/contracts/src/sql-mission-store.js";
import { canonicalJson } from "../dist/packages/judgment/src/canonical.js";
import { runApprovedWorkerService } from "../dist/apps/worker/src/approved-service.js";

const databaseUrl = process.env.ORLOOM_LIFECYCLE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Explicit fresh isolated lifecycle-test database required");
const first = await PostgresJobStore.connect(databaseUrl), second = await PostgresJobStore.connect(databaseUrl);
const store = new SqlMissionStore(first), readback = new SqlMissionStore(second);
const hash = value => createHash("sha256").update(value).digest("hex");
const checks = ["node-repo-suite-v1"], policy = hash(canonicalJson(checks)), cases = [];
try {
  await store.configureCapacity(1, hash("synthetic-lifecycle-capacity"), new Date(Date.now() + 600_000).toISOString());
  for (const mode of ["signal", "expiry", "owner-cancel"]) {
    let now = Date.now(), verified = false;
    const mission = await store.submit({ repository: `fixture/lifecycle-${mode}`, baseSha: "a".repeat(40), objective: "Observe interruption boundaries", acceptance: ["No new integration or delivery after stop"], budgetCents: 100 });
    const slice = { id: "slice", objective: "Synthetic lifecycle fixture", dependencies: [], owner: "fixture-builder", scopes: ["src"], checks, budgetCents: 100 };
    await store.recommendPlan(mission.id, [slice], "fixture-owner"); await store.approvePlan(mission.id);
    const grant = await store.claim(300, policy, checks); assert(grant);
    await store.complete(mission.id, slice.id, grant.epoch, grant.leaseToken, grant.capabilityToken, "b".repeat(40), []);
    const task = { missionId: mission.id, sliceId: slice.id, repository: mission.repository, baseSha: mission.baseSha, planDigest: hash(canonicalJson([slice])), trustedCheckPolicyDigest: policy, maxBudgetCents: 100, expiresAt: new Date(now + 60_000).toISOString() };
    const integrationRequest = { version: "orloom.integration-request.v1", missionId: mission.id, sliceId: slice.id, leaseEpoch: grant.epoch, candidateSha: "b".repeat(40), expectedIntegrationSha: mission.baseSha, requiredCheckIds: checks, reviewArtifactId: "synthetic-review", reviewArtifactDigest: "c".repeat(64) };
    const deliveryCommand = { version: "orloom.delivery-command.v1", missionId: mission.id, sliceId: slice.id, leaseEpoch: grant.epoch, integratedSha: "b".repeat(40), treeSha: "d".repeat(40), reviewArtifactId: integrationRequest.reviewArtifactId, reviewArtifactDigest: integrationRequest.reviewArtifactDigest, idempotencyKey: "synthetic-lifecycle-effect" };
    const controller = new AbortController(), calls = { verification: 0, prepare: 0, integration: 0, delivery: 0, builder: 0 };
    const result = await runApprovedWorkerService({ task, integrationRequest, deliveryCommand, signal: controller.signal, now: () => now, minimumSliceBudgetCents: 1, leaseSeconds: 300, executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["fixture"], allowedModels: ["fixture"] } }, {
      store, async reconcileInterrupted() {}, async reconcileRetained() {},
      async executeLane() { calls.builder++; throw new Error("No builder authorized by this fixture"); },
      trustedChecks: {
        async getCertificate() { return verified ? { certificateId: "synthetic-presence-only" } : null; },
        async verifySlice() { calls.verification++; verified = true; if (mode === "signal") controller.abort(); else if (mode === "expiry") now += 60_001; else await readback.requestCancel(mission.id, `stop-${mode}`, "Owner stops while synthetic verification callback completes"); }
      },
      governor: { async integrateVerifiedSlice() { calls.integration++; }, async deliverIntegratedCommit() { calls.delivery++; } },
      async prepareCertifiedIntegration() { calls.prepare++; }, integrationAuthority: {}, deliveryPolicy: {}, deliveryAuthority: {}
    });
    assert.equal(result, "unknown", mode); assert.deepEqual(calls, { verification: 1, prepare: 0, integration: 0, delivery: 0, builder: 0 });
    assert.equal((await readback.getMission(mission.id)).mission.reservedCents, 100);
    cases.push({ mode, result, calls, reservedCents: 100 });
    // Retain the real awaiting-verification/cancelling state. This fixture has
    // no runtime absence proof and must not force settlement or refund spend.
  }
  console.log(JSON.stringify({ status: "PASS", database: "isolated actual PostgreSQL", connections: 2, cases, limitations: ["Verification callback and certificate-presence result are explicit synthetic fixtures", "No actual provider, verifier, runtime, integration ref, artifact upload, GitHub Check or PR effect is executed", "Actual SQL mission/lease/cancellation state and conservative reservations are exercised"] }, null, 2));
} finally { await first.close(); await second.close(); }
