import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";
import { FileRuntimeJournal, RUNTIME_RECONCILER_SOURCE } from "../apps/worker/src/runtime-journal.js";
import { controllerRunIdForApprovedTask, reconcileApprovedWorkerRetained, runApprovedWorkerService, type ApprovedWorkerServiceOptions } from "../apps/worker/src/approved-service.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import type { MissionStore, SliceInput } from "../packages/contracts/src/mission.js";
import type { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const checkIds = ["check:unit"];
const policyDigest = digest(canonicalJson(checkIds));
const planSlice: SliceInput = { id: "approved-slice", objective: "one bounded change", dependencies: [], owner: "builder", scopes: ["src"], checks: checkIds, budgetCents: 100 };
const planDigest = digest(canonicalJson([planSlice]));
const limits = { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxWallSeconds: 120, allowedProviders: ["deepseek"], allowedModels: ["deepseek-chat"] };

function sql(db: PGlite): TransactionalSql {
  let tail = Promise.resolve();
  return {
    query: async (text, params) => await db.query(text, params as never) as never,
    transaction: async <T>(work: (tx: { query: TransactionalSql["query"] }) => Promise<T>) => {
      let release!: () => void; const before = tail; tail = new Promise<void>(resolve => { release = resolve; });
      return before.then(async () => { try { await db.exec("BEGIN"); const value = await work({ query: async (text, params) => await db.query(text, params as never) as never }); await db.exec("COMMIT"); return value; } catch (error) { await db.exec("ROLLBACK"); throw error; } finally { release(); } });
    }
  };
}

async function migrate(db: PGlite): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");
  for (const name of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(`db/migrations/${name}`, "utf8"));
}

async function prepareStore(store: MemoryMissionStore | SqlMissionStore, mode: "complete" | "pre-runtime" | "intent" = "complete") {
  await store.configureCapacity(1, policyDigest, new Date(Date.now() + 300_000).toISOString());
  const mission = await store.submit({ repository: "owner/repo", baseSha: "a".repeat(40), objective: "restart one approved worker", acceptance: ["review the exact candidate"], budgetCents: 100 });
  await store.recommendPlan(mission.id, [planSlice], "owner"); await store.approvePlan(mission.id);
  const grant = await store.claim(300, policyDigest, checkIds); assert(grant);
  const task = { missionId: mission.id, sliceId: planSlice.id, repository: "owner/repo", baseSha: "a".repeat(40), planDigest, trustedCheckPolicyDigest: policyDigest, maxBudgetCents: 100, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const identity = { missionId: mission.id, sliceId: planSlice.id, leaseEpoch: grant.epoch, controllerRunId: controllerRunIdForApprovedTask(task, grant.epoch) };
  const imageRef = `sha256:${"b".repeat(64)}`, labelsDigest = "c".repeat(64), containerId = "d".repeat(64);
  const root = await mkdtemp(path.join(os.tmpdir(), "orloom-approved-restart-"));
  const journal = await FileRuntimeJournal.openPortableTestRoot(root);
  const bridge = new TrustedRuntimeJournalBridge(journal, store);
  if (mode === "intent") await bridge.recordIntent({ identity, name: "orloom-worker-approved-slice", imageRef, labelsDigest });
  if (mode === "complete") {
    await bridge.recordIntent({ identity, name: "orloom-worker-approved-slice", imageRef, labelsDigest });
    await bridge.recordCreated(identity, containerId, labelsDigest);
    const observedAt = new Date().toISOString();
    await bridge.recordAbsent({ source: RUNTIME_RECONCILER_SOURCE, outcome: "absent", identity, name: "orloom-worker-approved-slice", imageRef, labelsDigest, containerId, observedAt });
    await store.complete(mission.id, planSlice.id, grant.epoch, grant.leaseToken, grant.capabilityToken, "e".repeat(40), []);
  }
  const serviceOptions: ApprovedWorkerServiceOptions = { task, executionLimits: limits, minimumSliceBudgetCents: 50, leaseSeconds: 300 };
  let executeCalls = 0;
  const certificateChecks = { async getCertificate() { return { certificateId: "retained-fixture-certificate" }; }, async verifySlice() { throw new Error("terminal candidate must not be redispatched"); } } as unknown as TrustedCheckCoordinator;
  const dependencies = {
    store: store as unknown as MissionStore,
    governor: {} as MissionGovernor,
    trustedChecks: certificateChecks,
    async reconcileInterrupted() {},
    async reconcileRetained(target: Parameters<typeof reconcileApprovedWorkerRetained>[1], epoch: number) { await reconcileApprovedWorkerRetained(bridge, target, controllerRunIdForApprovedTask(task, epoch)); },
    async executeLane() { executeCalls++; throw new Error("restart must never execute builder work"); },
  };
  return { missionId: mission.id, task, options: serviceOptions, dependencies, store, bridge, root, get executeCalls() { return executeCalls; } };
}

test("memory service restart accepts exact retained ABSENT, awaits review, then settles later owner cancellation", async () => {
  const store = new MemoryMissionStore(); const fixture = await prepareStore(store);
  try {
    assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "awaiting_review");
    assert.equal(fixture.executeCalls, 0);
    const before = await store.getMission(fixture.missionId);
    const reserved = before?.mission.reservedCents;
    await store.requestCancel(fixture.missionId, "owner-stop-after-verified-run", "stop before further processing");
    assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled");
    const after = await store.getMission(fixture.missionId);
    assert.equal(after?.slices[0]?.status, "cancelled");
    assert.equal(after?.mission.reservedCents, reserved, "replay never refunds uncertain spend");
    assert.equal(fixture.executeCalls, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("SQL service restart replays the exact completed journal through the production callback without builder execution", async () => {
  const db = new PGlite();
  try {
    await migrate(db); const store = new SqlMissionStore(sql(db)); const fixture = await prepareStore(store);
    try {
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "awaiting_review");
      assert.equal(fixture.executeCalls, 0);
      const mission = await store.getMission(fixture.missionId); const epoch = mission!.slices[0]!.leaseEpoch;
      await db.query("UPDATE mission_slices SET status='verified' WHERE mission_id=$1 AND id=$2", [fixture.missionId, planSlice.id]);
      await db.query("UPDATE missions SET status='verified' WHERE id=$1", [fixture.missionId]);
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "awaiting_review", "verified restart must replay the validated retained journal and remain review-gated");
      assert.equal(fixture.executeCalls, 0);
      assert.equal((await store.getMission(fixture.missionId))?.slices[0]?.leaseEpoch, epoch);
      await db.query("UPDATE cancellation_runtime_bindings SET reconciliation_evidence=jsonb_set(reconciliation_evidence,'{labelsDigest}',$2::jsonb) WHERE mission_id=$1 AND slice_id=$3 AND lease_epoch=$4", [fixture.missionId, JSON.stringify("f".repeat(64)), planSlice.id, epoch]);
      await assert.rejects(runApprovedWorkerService(fixture.options, fixture.dependencies), /malformed, stale, or quarantined/);
      assert.equal(fixture.executeCalls, 0, "corrupt retained proof must stop startup before builder execution");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  } finally { await db.close(); }
});

test("memory service settles owner cancellation before runtime binding and replays idempotently", async () => {
  const store = new MemoryMissionStore(); const fixture = await prepareStore(store, "pre-runtime");
  try {
    await store.requestCancel(fixture.missionId, "owner-pre-runtime-cancel", "cancel before runtime creation");
    assert.equal((await store.getMission(fixture.missionId))?.slices[0]?.status, "cancel_requested");
    const reserved = (await store.getMission(fixture.missionId))?.mission.reservedCents;
    assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled");
    assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled", "no-runtime settlement is idempotent across restart");
    const after = await store.getMission(fixture.missionId);
    assert.equal(after?.slices[0]?.status, "cancelled"); assert.equal(after?.mission.reservedCents, reserved);
    assert.equal(fixture.executeCalls, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("SQL service settles owner cancellation before runtime binding and replays idempotently", async () => {
  const db = new PGlite();
  try {
    await migrate(db); const store = new SqlMissionStore(sql(db)); const fixture = await prepareStore(store, "pre-runtime");
    try {
      await store.requestCancel(fixture.missionId, "owner-pre-runtime-cancel", "cancel before runtime creation");
      assert.equal((await store.getMission(fixture.missionId))?.slices[0]?.status, "cancel_requested");
      const reserved = (await store.getMission(fixture.missionId))?.mission.reservedCents;
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled");
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled", "no-runtime settlement is idempotent across restart");
      const after = await store.getMission(fixture.missionId);
      assert.equal(after?.slices[0]?.status, "cancelled"); assert.equal(after?.mission.reservedCents, reserved);
      assert.equal(fixture.executeCalls, 0);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  } finally { await db.close(); }
});

async function assertCapacityHeld(store: MemoryMissionStore | SqlMissionStore): Promise<void> {
  const competing = await store.submit({ repository: "other/repo", baseSha: "f".repeat(40), objective: "prove held capacity", acceptance: ["no second lease"], budgetCents: 100 });
  await store.recommendPlan(competing.id, [{ ...planSlice, id: "other-slice" }], "owner"); await store.approvePlan(competing.id);
  assert.equal(await store.claim(300, policyDigest, checkIds), null, "unknown/cancel-pending lease retains its capacity slot");
}

for (const kind of ["memory", "sql"] as const) {
  test(`expired no-runtime UNKNOWN settles only after owner cancellation (${kind}), idempotently`, async () => {
    const db = kind === "sql" ? new PGlite() : null;
    if (db) await migrate(db);
    const store = kind === "memory" ? new MemoryMissionStore() : new SqlMissionStore(sql(db!));
    const fixture = await prepareStore(store, "pre-runtime");
    try {
      assert.equal(await store.expire(new Date(Date.now() + 600_000)), 1);
      assert.equal((await store.getMission(fixture.missionId))?.slices[0]?.status, "unknown");
      await store.requestCancel(fixture.missionId, "owner-stop-expired-before-runtime", "cancel an expired lease with no runtime intent");
      assert.equal((await store.getMission(fixture.missionId))?.mission.status, "cancelling");
      const reserved = (await store.getMission(fixture.missionId))?.mission.reservedCents;
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled");
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "cancelled");
      const after = await store.getMission(fixture.missionId);
      assert.equal(after?.slices[0]?.status, "cancelled"); assert.equal(after?.mission.reservedCents, reserved);
      assert.equal(fixture.executeCalls, 0);
    } finally { await rm(fixture.root, { recursive: true, force: true }); if (db) await db.close(); }
  });
}

for (const kind of ["memory", "sql"] as const) {
  test(`non-cancelling expired UNKNOWN remains fenced and retains capacity/spend (${kind})`, async () => {
    const db = kind === "sql" ? new PGlite() : null;
    if (db) await migrate(db);
    const store = kind === "memory" ? new MemoryMissionStore() : new SqlMissionStore(sql(db!));
    const fixture = await prepareStore(store, "pre-runtime");
    try {
      assert.equal(await store.expire(new Date(Date.now() + 600_000)), 1);
      const reserved = (await store.getMission(fixture.missionId))?.mission.reservedCents;
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "unknown");
      const after = await store.getMission(fixture.missionId);
      assert.equal(after?.slices[0]?.status, "unknown"); assert.equal(after?.mission.reservedCents, reserved);
      await assertCapacityHeld(store); assert.equal(fixture.executeCalls, 0);
    } finally { await rm(fixture.root, { recursive: true, force: true }); if (db) await db.close(); }
  });
}

test("bound file-intent UNKNOWN stays quarantined after owner cancellation", async () => {
  const db = new PGlite();
  try {
    await migrate(db); const store = new SqlMissionStore(sql(db)); const fixture = await prepareStore(store, "intent");
    try {
      assert.equal(await store.expire(new Date(Date.now() + 600_000)), 1);
      await store.requestCancel(fixture.missionId, "owner-stop-bound-unknown", "do not settle a lease with runtime intent");
      const reserved = (await store.getMission(fixture.missionId))?.mission.reservedCents;
      assert.equal(await runApprovedWorkerService(fixture.options, fixture.dependencies), "unknown");
      const after = await store.getMission(fixture.missionId);
      assert.equal(after?.mission.status, "cancelling"); assert.equal(after?.slices[0]?.status, "unknown");
      assert.equal(after?.mission.reservedCents, reserved); await assertCapacityHeld(store);
      assert.equal(fixture.executeCalls, 0);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  } finally { await db.close(); }
});
