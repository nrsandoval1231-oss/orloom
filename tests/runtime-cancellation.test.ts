import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionConflictError, MissionStore, MissionValidationError, type SliceInput } from "../packages/contracts/src/mission.js";

const sha = (character: string) => character.repeat(64);
const future = () => new Date(Date.now() + 300_000).toISOString();
const slice = (id: string, scope: string, budgetCents = 100, dependencies: string[] = []): SliceInput =>
  ({ id, objective: `do ${id}`, dependencies, owner: "core", scopes: [scope], checks: ["check:unit"], budgetCents });

type Hook = (text: string) => Promise<void> | void;

/** A single-connection transactional executor. `tail` serializes transactions exactly like a real pool. */
function testSql(db: PGlite, hook?: Hook): TransactionalSql {
  let tail = Promise.resolve();
  const query = async (text: string, params?: unknown[]) => {
    if (hook) await hook(text);
    return await db.query(text, params as never) as never;
  };
  return {
    query,
    transaction: async <T>(work: (tx: { query: TransactionalSql["query"] }) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const prior = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        await db.exec("BEGIN");
        const result = await work({ query });
        await db.exec("COMMIT");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      } finally { release(); }
    }
  };
}

function barrier() {
  let signal!: () => void;
  let resume!: () => void;
  let used = false;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  return { reached, release: () => resume(), pause: async () => { if (used) return; used = true; signal(); await released; } };
}
async function waitAtBarrier(value: ReturnType<typeof barrier>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([value.reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cancellation race barrier was not reached")), 10_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function migrate(db: PGlite) {
  for (const file of (await readdir("db/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
}

async function rows(db: PGlite, text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> {
  return (await db.query(text, params as never)).rows as Array<Record<string, unknown>>;
}

async function store(db: PGlite, hook?: Hook, capacity = 1) {
  const value = new SqlMissionStore(testSql(db, hook));
  await value.configureCapacity(capacity, sha("a"), future());
  return value;
}

async function approvedMission(value: MissionStore, repository: string, slices: SliceInput[], budgetCents = 300) {
  const mission = await value.submit({ repository, baseSha: "b".repeat(40), objective: "owner cancellation", acceptance: ["owner can stop"], budgetCents });
  await value.recommendPlan(mission.id, slices, "owner-session");
  await value.approvePlan(mission.id);
  return mission;
}

const leaseColumns = async (db: PGlite, missionId: string, sliceId: string) => {
  const q = await rows(db, "SELECT status,lease_epoch,lease_token_hash,capability_hash,lease_expires_at,capacity_slot FROM mission_slices WHERE mission_id=$1 AND id=$2", [missionId, sliceId]);
  const row = q[0]!;
  return {
    status: String(row.status),
    epoch: Number(row.lease_epoch),
    leaseTokenHash: row.lease_token_hash === null ? null : String(row.lease_token_hash),
    capabilityHash: row.capability_hash === null ? null : String(row.capability_hash),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    capacitySlot: row.capacity_slot === null ? null : Number(row.capacity_slot)
  };
};

test("the cancellation migration is idempotent when re-applied to an already-migrated database", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    // postgres-store.ts re-executes every migration file on every startup, so 009
    // must tolerate being applied again to an already-migrated database.
    const cancellationMigration = await readFile("db/migrations/009_worker_runtime.sql", "utf8");
    await db.exec(cancellationMigration);
    await db.exec(cancellationMigration);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    await missionStore.requestCancel!(mission.id, "owner-cancel-idempotent-migration", "owner requested stop");
    assert.equal((await missionStore.getMission(mission.id))!.slices[0]!.status, "cancel_requested");
    const constrained = await rows(db, "SELECT conname FROM pg_constraint WHERE conname IN ('missions_status_check','mission_slices_status_check','mission_slices_check')");
    assert.equal(constrained.length, 3, "each re-run leaves exactly one copy of every status constraint");
  } finally { await db.close(); }
});

test("owner cancellation is idempotent for the same request id and refuses a competing one", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src/**")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);

    await missionStore.requestCancel!(mission.id, "owner-cancel-1", "owner requested stop");
    await missionStore.requestCancel!(mission.id, "owner-cancel-1", "owner requested stop");
    await assert.rejects(missionStore.requestCancel!(mission.id, "owner-cancel-2", "competing owner"), MissionConflictError);

    const cancellationRows = await rows(db, "SELECT owner_request_id FROM mission_cancellations WHERE mission_id=$1", [mission.id]);
    assert.deepEqual(cancellationRows.map((row) => String(row.owner_request_id)), ["owner-cancel-1"]);
    assert.equal((await missionStore.events(mission.id, 0)).filter((event) => event.type === "mission.cancellation_requested").length, 1, "one cancellation event");

    // Malformed owner identity or reason is a validation refusal, not a state conflict.
    await assert.rejects(missionStore.requestCancel!(mission.id, "bad id!", "stop"), MissionValidationError);
    await assert.rejects(missionStore.requestCancel!(mission.id, "owner-cancel-1", "   "), MissionValidationError);
    await assert.rejects(missionStore.requestCancel!(mission.id, "owner-cancel-1", "x".repeat(2_001)), MissionValidationError);
    await assert.rejects(missionStore.requestCancel!(mission.id, "", "stop"), MissionValidationError);
  } finally { await db.close(); }
});

test("cancellation fences the still-unexpired lease and retains its proof and the reservation", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src/**")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    await missionStore.requestCancel!(mission.id, "owner-cancel-lease", "owner requested stop");

    const record = await missionStore.getMission(mission.id);
    assert(record);
    assert.equal(record.mission.status, "cancelling");
    assert.equal(record.mission.reservedCents, 100, "cancellation never refunds reserved spend");
    assert.equal(record.slices[0]!.status, "cancel_requested");

    // The durable lease proof is retained so the cancellation poll can authenticate it.
    const retained = await leaseColumns(db, mission.id, "slice");
    assert.equal(retained.status, "cancel_requested");
    assert.equal(retained.epoch, lease.epoch);
    assert.equal(retained.leaseTokenHash !== null, true);
    assert.equal(retained.capabilityHash !== null, true);
    assert.equal(retained.leaseExpiresAt !== null, true);
    assert.equal(retained.capacitySlot !== null, true);

    // The still-unexpired lease can no longer produce any terminal claim.
    await assert.rejects(missionStore.complete(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken, "d".repeat(40), []), MissionConflictError);
    await assert.rejects(missionStore.heartbeat(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken, 300), MissionConflictError);
    await assert.rejects(missionStore.reportOutcome(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken, "BLOCKED", "other", []), MissionConflictError);

    const after = await leaseColumns(db, mission.id, "slice");
    assert.equal(after.status, "cancel_requested", "no worker submission changed the fenced slice");
    assert.equal((await missionStore.getMission(mission.id))!.mission.reservedCents, 100);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), true);

    // Lease expiry reconciliation must never resurrect or re-open a fenced slice.
    assert.equal(await missionStore.expire(new Date(Date.now() + 10_000_000)), 0);
    const expired = await missionStore.getMission(mission.id);
    assert.equal(expired!.slices[0]!.status, "cancel_requested");
    assert.equal(expired!.mission.status, "cancelling", "lease reconciliation cannot clear a sticky cancellation");
  } finally { await db.close(); }
});

test("cancellationStatus is false for a stale epoch, a superseded lease, an expired lease, or a wrong token", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src/**")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    await missionStore.requestCancel!(mission.id, "owner-cancel-status", "owner requested stop");

    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), true);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, "wrong-lease-token", lease.capabilityToken), false);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, "wrong-capability-token"), false);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch + 1, lease.leaseToken, lease.capabilityToken), false);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch - 1, lease.leaseToken, lease.capabilityToken), false);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "other-slice", lease.epoch, lease.leaseToken, lease.capabilityToken), false);

    // An expired lease is no longer cancellable: the poll is re-derived, never asserted.
    await db.query("UPDATE mission_slices SET lease_expires_at=now()-interval '1 second' WHERE mission_id=$1 AND id=$2", [mission.id, "slice"]);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), false);

    // A superseded lease epoch keeps the original binding stale forever.
    await db.query("UPDATE mission_slices SET lease_expires_at=now()+interval '5 minutes', lease_epoch=lease_epoch+1 WHERE mission_id=$1 AND id=$2", [mission.id, "slice"]);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), false);
  } finally { await db.close(); }
});

test("cancellation blocks new claims for the slice and its mission and releases no capacity", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    await missionStore.requestCancel!(mission.id, "owner-cancel-claim", "owner requested stop");

    assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null, "no new claim inside the cancelling mission");

    // A disjoint mission still cannot take the slot: the cancel_requested slice holds it.
    const other = await approvedMission(missionStore, "owner/other", [slice("other", "other")], 100);
    assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null, "cancel_requested keeps its capacity slot");
    const otherRecord = await missionStore.getMission(other.id);
    assert.equal(otherRecord!.mission.reservedCents, 0);
    assert.equal(otherRecord!.slices[0]!.status, "ready");
  } finally { await db.close(); }
});

test("lease-less slices become durable tombstones and a fully settled mission completes cancellation", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    // Capacity 0: no slice ever acquires a lease, so the whole mission is settled at once.
    const missionStore = await store(db, undefined, 0);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("first", "src/a/**"), slice("second", "src/b/**")]);
    await missionStore.requestCancel!(mission.id, "owner-cancel-idle", "owner requested stop");

    const record = await missionStore.getMission(mission.id);
    assert(record);
    assert.equal(record.mission.status, "cancelled");
    assert.equal(record.mission.reservedCents, 0);
    assert.deepEqual(record.slices.map((entry) => entry.status).sort(), ["cancelled", "cancelled"]);
    const completed = await rows(db, "SELECT completed_at FROM mission_cancellations WHERE mission_id=$1", [mission.id]);
    assert.equal(completed[0]!.completed_at !== null, true);
    assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null, "no claim may revive a cancelled mission");
  } finally { await db.close(); }
});

test("cancellation survives a store restart against the same database", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src/**")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    await missionStore.requestCancel!(mission.id, "owner-cancel-restart", "owner requested stop");

    const reopened = new SqlMissionStore(testSql(db));
    const record = await reopened.getMission(mission.id);
    assert(record);
    assert.equal(record.mission.status, "cancelling");
    assert.equal(record.mission.reservedCents, 100);
    assert.equal(record.slices[0]!.status, "cancel_requested");
    assert.equal(await reopened.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), true);
    assert.equal(await reopened.claim(300, sha("c"), ["check:unit"]), null);
    const ownerRows = await rows(db, "SELECT owner_request_id FROM mission_cancellations WHERE mission_id=$1", [mission.id]);
    assert.deepEqual(ownerRows.map((row) => String(row.owner_request_id)), ["owner-cancel-restart"]);
  } finally { await db.close(); }
});

test("no worker-supplied assertion can complete a cancelled mission or release its capacity", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("alpha", "src/a"), slice("beta", "src/b")]);

    const first = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(first);
    await missionStore.complete(mission.id, first.slice.id, first.epoch, first.leaseToken, first.capabilityToken, "d".repeat(40), []);
    const second = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(second);
    assert.notEqual(second.slice.id, first.slice.id);
    assert.equal((await missionStore.getMission(mission.id))!.mission.reservedCents, 200);
    const settledId = first.slice.id, liveId = second.slice.id;

    await missionStore.requestCancel!(mission.id, "owner-cancel-worker", "owner requested stop");
    const fenced = await missionStore.getMission(mission.id);
    assert(fenced);
    assert.equal(fenced.mission.status, "cancelling");
    assert.equal(fenced.mission.reservedCents, 200, "worker-visible cancellation never refunds");
    assert.equal(fenced.slices.find((entry) => entry.id === liveId)!.status, "cancel_requested");
    assert.equal(fenced.slices.find((entry) => entry.id === settledId)!.status, "awaiting_verification");

    // Every worker-reachable mutating path is fenced.
    await assert.rejects(missionStore.complete(mission.id, liveId, second.epoch, second.leaseToken, second.capabilityToken, "e".repeat(40), ["worker://claim"]), MissionConflictError);
    await assert.rejects(missionStore.heartbeat(mission.id, liveId, second.epoch, second.leaseToken, second.capabilityToken, 300), MissionConflictError);
    await assert.rejects(missionStore.reportOutcome(mission.id, liveId, second.epoch, second.leaseToken, second.capabilityToken, "UNKNOWN", "other", []), MissionConflictError);
    await assert.rejects(missionStore.integrate(mission.id, settledId, "d".repeat(40), sha("c"), ["check:unit"], "integration", "verifier"), MissionConflictError);
    // The settled candidate cannot be promoted to verified behind the owner's back either.
    await assert.rejects(missionStore.createIntegrationIntent!({
      version: "orloom.integration-request.v1", missionId: mission.id, sliceId: settledId, expectedIntegrationSha: "d".repeat(40), candidateSha: "d".repeat(40),
      leaseEpoch: first.epoch, requiredCheckIds: ["check:unit"], reviewArtifactId: "review-1", reviewArtifactDigest: sha("f")
    }, "0".repeat(40), [], [], { planDigest: sha("1"), policyDigest: sha("2") }), MissionConflictError);
    assert.deepEqual(await missionStore.awaitingVerification!(["check:unit"]), [], "cancelled missions stop dispatching trusted verification");

    const after = await missionStore.getMission(mission.id);
    assert.equal(after!.slices.find((entry) => entry.id === liveId)!.status, "cancel_requested");
    assert.equal(after!.slices.find((entry) => entry.id === settledId)!.status, "awaiting_verification");
    assert.equal(after!.mission.reservedCents, 200);
    assert.equal((await leaseColumns(db, mission.id, liveId)).capacitySlot !== null, true);

    // Capacity is still consumed: a disjoint mission cannot claim over the fenced lease.
    await approvedMission(missionStore, "owner/other", [slice("other", "other")], 100);
    assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null);
  } finally { await db.close(); }
});

test("an interleaved claim/cancel race keeps the winner fenced and never double-books or refunds", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const gate = barrier();
    let armed = true;
    // Pause inside claim's own transaction, after the governor lock is held, so the
    // concurrent owner cancellation is queued behind the in-flight claim.
    const missionStore = await store(db, async (text) => {
      if (armed && text.includes("FOR UPDATE OF s SKIP LOCKED")) { armed = false; await gate.pause(); }
    }, 2);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);

    const claiming = missionStore.claim(300, sha("c"), ["check:unit"]);
    // The barrier is only released once the in-flight claim provably holds its
    // transaction, so the owner cancellation is queued strictly behind it.
    await waitAtBarrier(gate);
    const cancelling = missionStore.requestCancel(mission.id, "owner-cancel-race", "owner requested stop during dispatch");
    gate.release();
    const [lease] = await Promise.all([claiming, cancelling]);
    assert(lease, "the in-flight claim still wins its lease exactly once");

    const record = await missionStore.getMission(mission.id);
    assert(record);
    assert.equal(record.mission.status, "cancelling", "the queued cancellation observed and fenced the winner");
    assert.equal(record.mission.reservedCents, 100, "exactly one reservation, never refunded");
    assert.equal(record.slices[0]!.status, "cancel_requested");
    assert.equal(record.slices[0]!.leaseEpoch, lease.epoch);
    assert.equal(await missionStore.cancellationStatus!(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), true);
    await assert.rejects(missionStore.complete(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken, "d".repeat(40), []), MissionConflictError);
    assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null);

    // The opposite interleaving: a cancellation that lands first leaves nothing to claim.
    const secondMission = await approvedMission(missionStore, "owner/second", [slice("slice", "second")], 100);
    await missionStore.requestCancel(secondMission.id, "owner-cancel-first", "owner requested stop before dispatch");
    assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null);
    const secondRecord = await missionStore.getMission(secondMission.id);
    assert.equal(secondRecord!.slices[0]!.status, "cancelled", "a cancellation before dispatch is a tombstone, not a lease");
    assert.equal(secondRecord!.mission.reservedCents, 0);
    assert.equal((await missionStore.events(secondMission.id, 0)).filter((event) => event.type === "slice.claimed").length, 0);

    // Duplicate concurrent cancellation: one owner intent wins, the other conflicts.
    const settled = await approvedMission(missionStore, "owner/third", [slice("slice", "third")], 100);
    const results = await Promise.allSettled([
      missionStore.requestCancel(settled.id, "owner-cancel-a", "first owner intent"),
      missionStore.requestCancel(settled.id, "owner-cancel-b", "second owner intent")
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof MissionConflictError);
    const owners = await rows(db, "SELECT owner_request_id FROM mission_cancellations WHERE mission_id=$1", [settled.id]);
    assert.equal(owners.length, 1);
  } finally { await db.close(); }
});

test("the owner cancellation HTTP surface authenticates, validates, and exposes no worker route", async () => {
  const token = "owner-session-secret", policy = sha("c");
  const missionStore = new MemoryMissionStore();
  await missionStore.configureCapacity(1, sha("a"), future());
  const config = { mode: "local" as const, port: 0, sessionToken: token, workerToken: "worker-secret", capacitySlots: 1, maxLanes: 6, trustedCheckPolicy: ["check:unit"], trustedCheckPolicyDigest: policy };
  const server = createControlPlane(config, new MemoryJobStore(), missionStore);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cancelUrl = `${base}/api/missions/missing/cancel`;
    assert.equal((await fetch(cancelUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerRequestId: "owner-1", reason: "stop" }) })).status, 401, "cancellation requires an owner session");
    const login = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const ownerHeaders = { cookie: cookie!, "content-type": "application/json" };
    assert.equal((await fetch(cancelUrl, { method: "POST", headers: ownerHeaders, body: "null" })).status, 400);
    assert.equal((await fetch(cancelUrl, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "bad id!", reason: "stop" }) })).status, 400);
    assert.equal((await fetch(cancelUrl, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "owner-1", reason: "   " }) })).status, 400);
    assert.equal((await fetch(cancelUrl, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "owner-1", reason: "stop", extra: true }) })).status, 400);
    assert.equal((await fetch(cancelUrl, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "owner-1", reason: "stop" }) })).status, 409, "unknown mission is a state conflict, not a leaky error");

    const missionResponse = await fetch(`${base}/api/missions`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ repository: "owner/repo", baseSha: "a".repeat(40), objective: "cancellable", acceptance: ["stop"], budgetCents: 100 }) });
    assert.equal(missionResponse.status, 201);
    const mission = await missionResponse.json() as { id: string };
    assert.equal((await fetch(`${base}/api/missions/${mission.id}/plan`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ slices: [{ id: "slice", objective: "x", dependencies: [], owner: "core", scopes: ["src"], checks: ["check:unit"], budgetCents: 100 }] }) })).status, 201);
    assert.equal((await fetch(`${base}/api/missions/${mission.id}/approve`, { method: "POST", headers: { cookie: cookie! } })).status, 200);

    assert.equal((await fetch(`${base}/api/missions/${mission.id}/cancel`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "owner-http-1", reason: "owner requested stop" }) })).status, 202);
    assert.equal((await fetch(`${base}/api/missions/${mission.id}/cancel`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "owner-http-1", reason: "owner requested stop" }) })).status, 202, "same owner request id replays as accepted");
    assert.equal((await fetch(`${base}/api/missions/${mission.id}/cancel`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ownerRequestId: "owner-http-2", reason: "competing owner" }) })).status, 409);

    assert.equal((await fetch(`${base}/api/missions/${mission.id}/cancellation`)).status, 401);
    const state = await fetch(`${base}/api/missions/${mission.id}/cancellation`, { headers: { cookie: cookie! } });
    assert.equal(state.status, 200);
    const body = await state.json() as { requested: boolean; status: string; slices: Array<{ sliceId: string; status: string }> };
    assert.equal(body.requested, true);
    assert.equal(body.status, "cancelled");
    assert.deepEqual(body.slices, [{ sliceId: "slice", status: "cancelled", leaseEpoch: 0, leaseRetained: false }]);
    assert.equal((await fetch(`${base}/api/missions/missing/cancellation`, { headers: { cookie: cookie! } })).status, 404);
    assert.equal((await fetch(`${base}/api/worker/missions/${mission.id}/cancel`, { method: "POST", headers: { authorization: "Bearer worker-secret", "content-type": "application/json" }, body: JSON.stringify({ ownerRequestId: "w-1", reason: "stop" }) })).status, 404, "no worker-facing cancellation route");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

  // A store that cannot cancel fails closed instead of silently accepting the request.
  const limited = Object.create(missionStore) as MemoryMissionStore;
  (limited as unknown as { requestCancel?: unknown }).requestCancel = undefined;
  const limitedServer = createControlPlane({ ...config, port: 0 }, new MemoryJobStore(), limited);
  await new Promise<void>((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
  const limitedAddress = limitedServer.address();
  assert(limitedAddress && typeof limitedAddress !== "string");
  const limitedBase = `http://127.0.0.1:${limitedAddress.port}`;
  try {
    const limitedLogin = await fetch(`${limitedBase}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const limitedCookie = limitedLogin.headers.get("set-cookie")?.split(";")[0];
    assert(limitedCookie);
    const response = await fetch(`${limitedBase}/api/missions/anything/cancel`, { method: "POST", headers: { cookie: limitedCookie!, "content-type": "application/json" }, body: JSON.stringify({ ownerRequestId: "owner-1", reason: "stop" }) });
    assert.equal(response.status, 503);
  } finally { await new Promise<void>((resolve, reject) => limitedServer.close((error) => error ? reject(error) : resolve())); }
});

test("the in-memory store applies the same durable-tombstone and lease-retention fence", async () => {
  const missionStore = new MemoryMissionStore();
  await missionStore.configureCapacity(1, sha("a"), future());
  const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);
  const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
  assert(lease);
  await missionStore.requestCancel(mission.id, "owner-memory-1", "owner requested stop");

  const record = await missionStore.getMission(mission.id);
  assert(record);
  assert.equal(record.mission.status, "cancelling");
  assert.equal(record.mission.reservedCents, 100, "in-memory cancellation never refunds reserved spend");
  assert.equal(record.slices[0]!.status, "cancel_requested");
  assert.equal(record.slices[0]!.leaseExpiresAt !== null, true, "the memory store retains the lease proof");
  assert.equal(await missionStore.cancellationStatus(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken), true);
  assert.equal(await missionStore.cancellationStatus(mission.id, "slice", lease.epoch + 1, lease.leaseToken, lease.capabilityToken), false);
  assert.equal(await missionStore.cancellationStatus(mission.id, "slice", lease.epoch, "wrong", lease.capabilityToken), false);
  await assert.rejects(missionStore.complete(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken, "d".repeat(40), []), MissionConflictError);
  await assert.rejects(missionStore.requestCancel(mission.id, "owner-memory-2", "competing"), MissionConflictError);
  await missionStore.requestCancel(mission.id, "owner-memory-1", "owner requested stop");
  assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null);

  // A disjoint mission cannot take the slot the fenced slice still holds.
  await approvedMission(missionStore, "owner/other", [slice("other", "other")], 100);
  assert.equal(await missionStore.claim(300, sha("c"), ["check:unit"]), null);
  await missionStore.expire(new Date(Date.now() + 10_000_000));
  assert.equal((await missionStore.getMission(mission.id))!.slices[0]!.status, "cancel_requested");
});

test("every migration is idempotent under a real startup re-execution", async () => {
  const db = new PGlite();
  try {
    // This is the actual startup path: PostgresJobStore.connect() re-executes the
    // whole migration directory every time, so applying the directory twice must
    // be a no-op. 005_learning.sql previously broke this on the second run.
    await migrate(db);
    await migrate(db);
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);
    assert(await missionStore.claim(300, sha("c"), ["check:unit"]));
    await missionStore.requestCancel!(mission.id, "owner-cancel-after-restart", "owner requested stop");
    assert.equal((await missionStore.getMission(mission.id))!.slices[0]!.status, "cancel_requested");
  } finally { await db.close(); }
});

test("owner cancellation refuses an already-verified mission and preserves its terminal state", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    // Drive the mission to its terminal state directly: the path to `verified`
    // (trusted integration) is a separate gate, and this test is about the guard.
    await db.query("UPDATE missions SET status='verified' WHERE id=$1", [mission.id]);
    await assert.rejects(missionStore.requestCancel!(mission.id, "owner-cancel-verified", "stop it"), MissionConflictError);
    const after = await rows(db, "SELECT status FROM missions WHERE id=$1", [mission.id]);
    assert.equal(String(after[0]!.status), "verified", "cancellation must not regress a terminal mission");
    const cancellations = await rows(db, "SELECT count(*)::int AS n FROM mission_cancellations WHERE mission_id=$1", [mission.id]);
    assert.equal(Number(cancellations[0]!.n), 0, "a refused cancellation writes no durable request");
  } finally { await db.close(); }
});

test("cancelling a blocked slice releases its capacity slot and still refunds nothing", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db, undefined, 1);
    const mission = await approvedMission(missionStore, "owner/repo", [slice("slice", "src")]);
    const lease = await missionStore.claim(300, sha("c"), ["check:unit"]);
    assert(lease);
    await missionStore.reportOutcome(mission.id, "slice", lease.epoch, lease.leaseToken, lease.capabilityToken, "BLOCKED", "dependency_missing", []);
    // Count slots that are enabled and unexpired *now*, exactly as claim() does.
    const freeCapacity = async () => Number((await rows(db, "SELECT count(*)::int AS free FROM capacity_slots c WHERE c.enabled=true AND c.evidence_expires_at>$1 AND NOT EXISTS(SELECT 1 FROM mission_slices ms WHERE ms.capacity_slot=c.slot_id AND ms.status IN ('running','cancel_requested','unknown','blocked'))", [new Date().toISOString()]))[0]!.free);
    assert.equal(await freeCapacity(), 0, "a blocked slice still holds its slot");
    const reservedBefore = Number((await rows(db, "SELECT reserved_cents FROM missions WHERE id=$1", [mission.id]))[0]!.reserved_cents);
    await missionStore.requestCancel!(mission.id, "owner-cancel-blocked", "owner requested stop");
    assert.equal((await missionStore.getMission(mission.id))!.slices[0]!.status, "cancelled");
    assert.equal(await freeCapacity(), 1, "cancelling a blocked slice does release its slot");
    assert.equal(Number((await rows(db, "SELECT reserved_cents FROM missions WHERE id=$1", [mission.id]))[0]!.reserved_cents), reservedBefore, "owner cancellation never refunds reserved spend");
  } finally { await db.close(); }
});

test("an owner request id may be reused on a different mission", async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const missionStore = await store(db, undefined, 2);
    const first = await approvedMission(missionStore, "owner/one", [slice("a", "a")]);
    const second = await approvedMission(missionStore, "owner/two", [slice("b", "b")]);
    await missionStore.requestCancel!(first.id, "shared-owner-request-id", "stop one");
    await missionStore.requestCancel!(second.id, "shared-owner-request-id", "stop two");
    assert.equal((await missionStore.getMission(second.id))!.mission.status, "cancelled");
  } finally { await db.close(); }
});

test('running lease polls owner cancellation over HTTP with exact credentials; stale requests reveal no cancellation', async () => {
  const missionStore = new MemoryMissionStore();
  await missionStore.configureCapacity(1, sha('a'), future());
  const mission = await approvedMission(missionStore, 'owner/repo', [slice('slice', 'src')]);
  const grant = await missionStore.claim(300, sha('c'), ['check:unit']); assert(grant);
  const server = createControlPlane({ mode: 'local', port: 0, sessionToken: 'owner', workerToken: 'worker', capacitySlots: 1, maxLanes: 6, trustedCheckPolicy: ['check:unit'], trustedCheckPolicyDigest: sha('c') }, new MemoryJobStore(), missionStore);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const url = `${base}/api/worker/missions/${mission.id}/slices/slice/cancellation`;
  const headers = { authorization: `Bearer ${grant.capabilityToken}`, 'x-orloom-lease-token': grant.leaseToken, 'x-orloom-lease-epoch': String(grant.epoch), 'content-type': 'application/json' };
  try {
    const poll = async (h = headers) => {
      const response = await fetch(url, { method: 'POST', headers: h, body: '{}' });
      assert.equal(response.status, 200); return (await response.json() as { requested: boolean }).requested;
    };
    assert.equal(await poll(), false);
    const login = await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'owner' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/api/missions/${mission.id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ownerRequestId: 'repeat', reason: 'stop running worker' }) })).status, 202);
    assert.equal(await poll(), true);
    assert.equal(await poll({ ...headers, 'x-orloom-lease-epoch': String(grant.epoch + 1) }), false);
    assert.equal(await poll({ ...headers, authorization: 'Bearer foreign' }), false);
    assert.equal(await poll({ ...headers, 'x-orloom-lease-token': 'foreign' }), false);
    const retained = await missionStore.getMission(mission.id); assert(retained);
    assert.equal(retained.mission.status, 'cancelling');
    assert.equal(retained.mission.reservedCents, 100);
    assert.equal(retained.slices[0]!.status, 'cancel_requested');
    assert.equal(await missionStore.claim(300, sha('c'), ['check:unit']), null);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
