import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgresJobStore } from "../dist/packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "../dist/packages/contracts/src/sql-mission-store.js";
import { MissionGovernor } from "../dist/packages/governor/src/governor.js";
import { canonicalJson } from "../dist/packages/judgment/src/canonical.js";
import { FileRuntimeJournal } from "../dist/apps/worker/src/runtime-journal.js";
import { TrustedRuntimeJournalBridge } from "../dist/apps/control-plane/src/trusted-runtime-journal-bridge.js";
import { reconcileApprovedWorkerRetained, runApprovedWorkerService } from "../dist/apps/worker/src/approved-service.js";

const databaseUrl = process.env.ORLOOM_RESTART_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Explicit fresh isolated restart-test database required");
const hash = value => createHash("sha256").update(value).digest("hex");
const checks = ["node-repo-suite-v1"], policy = hash(JSON.stringify(checks)), baseSha = "a".repeat(40), candidateSha = "b".repeat(40);
const root = await mkdtemp(path.join(tmpdir(), "orloom-pr26-restart-"));
const first = await PostgresJobStore.connect(databaseUrl), second = await PostgresJobStore.connect(databaseUrl);
try {
  const store = new SqlMissionStore(first), restarted = new SqlMissionStore(second);
  await store.configureCapacity(1, hash("restart-proof-capacity"), new Date(Date.now() + 600_000).toISOString());
  const config = { maxLanes: 1, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicy: checks, trustedCheckPolicyDigest: policy, executionConfigured: true };
  const governor = new MissionGovernor(store, config), recoveredGovernor = new MissionGovernor(restarted, config);
  let builderCalls = 0, verifierCalls = 0;
  const create = async suffix => {
    const mission = await store.submit({ repository: `fixture/${suffix}`, baseSha, objective: "one exact restart fixture", acceptance: ["conservative recovery"], budgetCents: 100 });
    const slice = { id: "slice", objective: "one exact restart fixture", dependencies: [], owner: "core", scopes: ["src"], checks, budgetCents: 100 };
    await store.recommendPlan(mission.id, [slice], "fixture-owner"); await store.approvePlan(mission.id);
    const task = { missionId: mission.id, sliceId: slice.id, repository: mission.repository, baseSha, planDigest: hash(canonicalJson([slice])), trustedCheckPolicyDigest: policy, maxBudgetCents: 100, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    const grant = await governor.claimApproved(task); assert(grant);
    const identity = { missionId: mission.id, sliceId: slice.id, leaseEpoch: grant.epoch, controllerRunId: hash(JSON.stringify(["orloom.worker-lease.v1", mission.id, slice.id, grant.epoch, task.planDigest, policy])) };
    const directory = path.join(root, suffix); await mkdir(directory, { mode: 0o700 });
    const journal = await FileRuntimeJournal.openPortableTestRoot(directory), bridge = new TrustedRuntimeJournalBridge(journal, restarted);
    const options = { task, executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 6, maxInputTokens: 50_000, maxOutputTokens: 10_000, maxWallSeconds: 180, allowedProviders: ["deepseek"], allowedModels: ["fixture-only"] }, minimumSliceBudgetCents: 1, leaseSeconds: 300 };
    const deps = certified => ({ store: restarted, governor: recoveredGovernor, trustedChecks: { async getCertificate() { return certified ? { certificateId: "controlled-restart-certificate" } : null; }, async verifySlice(missionId, sliceId) { assert.equal(missionId, mission.id); assert.equal(sliceId, slice.id); verifierCalls++; await restarted.recordVerificationUnavailable(missionId, sliceId, grant.epoch, checks[0], "candidate_unavailable"); } },
      async reconcileInterrupted() { assert.deepEqual(await journal.unresolved(), [], "these fixtures contain no live Docker runtime; retained ABSENT still traverses the real callback"); },
      async reconcileRetained(target) { await reconcileApprovedWorkerRetained(bridge, target, identity.controllerRunId); },
      async executeLane() { builderCalls++; throw new Error("restart must never execute a builder"); } });
    return { mission, slice, task, grant, identity, journal, bridge, options, deps };
  };

  const normal = await create("normal");
  const binding = { name: "orloom-worker-restart-proof", imageRef: `sha256:${"c".repeat(64)}`, labelsDigest: hash("restart-owned-labels") }, containerId = "d".repeat(64);
  await normal.bridge.recordIntent({ identity: normal.identity, ...binding });
  await normal.bridge.recordCreated(normal.identity, containerId, binding.labelsDigest);
  await normal.bridge.recordAbsent({ source: "orloom.trusted-docker-reconciler.v1", outcome: "absent", identity: normal.identity, ...binding, containerId, observedAt: new Date().toISOString() });
  await governor.complete(normal.mission.id, normal.slice.id, normal.grant.epoch, normal.grant.leaseToken, normal.grant.capabilityToken, candidateSha, []);
  assert.equal(await runApprovedWorkerService(normal.options, normal.deps(true)), "awaiting_review");
  assert.equal((await restarted.getMission(normal.mission.id)).slices[0].status, "awaiting_verification");
  assert.equal((await restarted.getMission(normal.mission.id)).mission.reservedCents, 100);
  const exact = (await normal.journal.entries())[0]; assert(exact);
  const corrupted = { ...exact, labelsDigest: hash("changed-labels") };
  const badBridge = new TrustedRuntimeJournalBridge({ ...normal.journal, async entries() { return [corrupted]; } }, restarted);
  await assert.rejects(reconcileApprovedWorkerRetained(badBridge, normal.task, normal.identity.controllerRunId), /quarantin|ignored|unresolved/i);
  await restarted.requestCancel(normal.mission.id, "later-owner-stop", "cancel after normal retained absence");
  assert.equal(await runApprovedWorkerService(normal.options, normal.deps(true)), "cancelled");
  assert.equal(await runApprovedWorkerService(normal.options, normal.deps(true)), "cancelled");
  assert.equal((await restarted.events(normal.mission.id, 0)).filter(event => event.type === "slice.cancellation_settled").length, 1);

  const beforeRuntime = await create("before-runtime");
  await store.requestCancel(beforeRuntime.mission.id, "pre-runtime-owner-stop", "crashed after claim before runtime intent");
  assert.equal(await runApprovedWorkerService(beforeRuntime.options, beforeRuntime.deps(false)), "cancelled");
  assert.equal(await runApprovedWorkerService(beforeRuntime.options, beforeRuntime.deps(false)), "cancelled");
  assert.equal((await restarted.getMission(beforeRuntime.mission.id)).mission.reservedCents, 100);
  assert.equal((await restarted.events(beforeRuntime.mission.id, 0)).filter(event => event.type === "slice.cancellation_settled_before_runtime").length, 1);

  const verified = await create("verified");
  await verified.bridge.recordIntent({ identity: verified.identity, ...binding });
  await verified.bridge.recordCreated(verified.identity, containerId, binding.labelsDigest);
  await verified.bridge.recordAbsent({ source: "orloom.trusted-docker-reconciler.v1", outcome: "absent", identity: verified.identity, ...binding, containerId, observedAt: new Date().toISOString() });
  await governor.complete(verified.mission.id, verified.slice.id, verified.grant.epoch, verified.grant.leaseToken, verified.grant.capabilityToken, candidateSha, []);
  assert.equal(await runApprovedWorkerService(verified.options, verified.deps(true)), "awaiting_review");
  // Controlled state fixture for the already-integrated branch; actual integration/ref/delivery
  // authority remains exercised by the separate genuine Git assembled integration test.
  await first.query("UPDATE mission_slices SET status='verified' WHERE mission_id=$1", [verified.mission.id]);
  await first.query("UPDATE missions SET status='verified' WHERE id=$1", [verified.mission.id]);
  assert.equal(await runApprovedWorkerService(verified.options, verified.deps(true)), "awaiting_review");
  assert.equal((await restarted.getMission(verified.mission.id)).slices[0].status, "verified");

  const target = await create("target");
  await governor.complete(target.mission.id, target.slice.id, target.grant.epoch, target.grant.leaseToken, target.grant.capabilityToken, candidateSha, []);
  await first.query("INSERT INTO missions(id,repository,base_sha,objective,acceptance,budget_cents,status) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'fixture/backlog-'||n,$1,'unrelated approved fixture','[\"verify\"]'::jsonb,1,'awaiting_verification' FROM generate_series(1,100) n", [baseSha]);
  await first.query("INSERT INTO mission_slices(mission_id,id,objective,dependencies,owner,scopes,checks,budget_cents,status,lease_epoch,candidate_sha) SELECT id,'slice','unrelated approved fixture','[]'::jsonb,'core','[\"src\"]'::jsonb,$1::jsonb,1,'awaiting_verification',1,$2 FROM missions WHERE repository LIKE 'fixture/backlog-%'", [JSON.stringify(checks), candidateSha]);
  await first.query("INSERT INTO mission_plans(mission_id,slices,recommended_by,approved_at) SELECT s.mission_id,jsonb_build_array(jsonb_build_object('id',s.id,'objective',s.objective,'dependencies',s.dependencies,'owner',s.owner,'scopes',s.scopes,'checks',s.checks,'budgetCents',s.budget_cents)),'fixture-owner',now() FROM mission_slices s JOIN missions m ON m.id=s.mission_id WHERE m.repository LIKE 'fixture/backlog-%'");
  const page = await restarted.awaitingVerification(checks, 10_000); assert.equal(page.length, 100); assert(!page.some(row => row.missionId === target.mission.id));
  assert.equal(await restarted.isVerificationDispatchEligible(target.mission.id, target.slice.id, target.grant.epoch, checks), true);
  assert.equal(await runApprovedWorkerService(target.options, target.deps(false)), "awaiting_verification");
  assert.equal(verifierCalls, 1); assert.equal(await restarted.isVerificationDispatchEligible(target.mission.id, target.slice.id, target.grant.epoch, checks), false);
  assert.equal(await restarted.isVerificationDispatchEligible(target.mission.id, target.slice.id, target.grant.epoch + 1, checks), false);

  const bound = await create("bound-no-file");
  await store.registerCancellationRuntimeBinding(bound.identity, binding);
  await store.requestCancel(bound.mission.id, "bound-owner-stop", "SQL intent exists but trusted file intent is unavailable");
  assert.equal(await runApprovedWorkerService(bound.options, bound.deps(false)), "unknown");
  assert.equal((await restarted.getMission(bound.mission.id)).slices[0].status, "cancel_requested");
  assert.equal((await restarted.getMission(bound.mission.id)).mission.reservedCents, 100);
  assert.equal(builderCalls, 0);
  console.log(JSON.stringify({ result: "PASS", database: "actual isolated PostgreSQL", normalAbsentRestart: "awaiting_review", verifiedAbsentRestart: "awaiting_review", laterCancellationReplay: "cancelled", noRuntimeCancellationRestart: "cancelled", bindingWithoutFile: "unknown", unrelatedVerificationCandidates: 100, exactTargetVerificationCalls: verifierCalls, builderCalls, reservedCents: 100, liveProvider: false, runsc: false, certificateFixture: true, verifiedStateFixture: true }));
} finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
