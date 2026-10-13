import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PostgresJobStore } from "./packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "./packages/contracts/src/sql-mission-store.js";

const password = (await readFile("/run/secrets/pg-password-test", "utf8")).trim();
const dbHost = process.env.ORLOOM_PG_HOST || "orloom-pg-proof-20261013-db";
assert.match(dbHost, /^[A-Za-z0-9.-]+$/);
const databaseUrl = `postgresql://mission_proof:${encodeURIComponent(password)}@${dbHost}:5432/mission_proof`;
const policy = "c".repeat(64);
const baseSha = "a".repeat(40);
const digest = "b".repeat(64);
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const slice = (id, scope, budgetCents = 100, dependencies = []) => ({
  id, objective: `bounded test ${id}`, dependencies, owner: "postgres-proof",
  scopes: [scope], checks: ["proof:postgres"], budgetCents
});
let stage = "connect";
let db;
const pass = (name) => process.stdout.write(`PASS ${name}\n`);
const submit = (store, repository, objective, budgetCents, rows) => store.submit({
  repository, baseSha, objective, acceptance: ["disposable PostgreSQL proof"], budgetCents
}).then(async (mission) => {
  await store.recommendPlan(mission.id, rows, "trusted-test-harness");
  await store.approvePlan(mission.id);
  return mission;
});

try {
  db = await PostgresJobStore.connect(databaseUrl);
  let store = new SqlMissionStore(db);
  const migrationRows = await db.query("SELECT version FROM orloom_schema_migrations ORDER BY version");
  assert.deepEqual(migrationRows.rows.map((r) => r.version).sort(), ["001_initial", "002_missions"]);
  pass("PostgreSQL migrations and readiness");

  stage = "real concurrent connections";
  const pids = await Promise.all(Array.from({ length: 8 }, () => db.transaction(async (tx) => {
    const result = await tx.query("SELECT pg_backend_pid() AS pid");
    await tx.query("SELECT pg_sleep(0.15)");
    return Number(result.rows[0].pid);
  })));
  assert(new Set(pids).size >= 6, "expected at least six simultaneous PostgreSQL backend sessions");
  pass(`real concurrent PostgreSQL sessions=${new Set(pids).size}`);

  stage = "six distinct claims";
  await store.configureCapacity(6, digest, future());
  const many = await submit(store, "owner/distinct-claims", "six disjoint slices", 700,
    Array.from({ length: 7 }, (_, i) => slice(`slice-${i + 1}`, `src/file-${i + 1}.ts`)));
  const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim(300, policy)));
  const grants = claims.filter(Boolean);
  assert.equal(grants.length, 6);
  assert.equal(new Set(grants.map((g) => g.slice.id)).size, 6);
  assert.equal(new Set(grants.map((g) => g.capacitySlot)).size, 6);
  assert.equal(await store.claim(300, policy), null);
  for (const grant of grants) {
    await store.complete(many.id, grant.slice.id, grant.epoch, grant.leaseToken, grant.capabilityToken,
      "d".repeat(40), ["proof://candidate"]);
  }
  const seventh = await store.claim(300, policy);
  assert(seventh && seventh.mission.id === many.id && seventh.slice.id === "slice-7");
  await store.complete(many.id, seventh.slice.id, seventh.epoch, seventh.leaseToken, seventh.capabilityToken,
    "3".repeat(40), ["proof://candidate"]);
  const eventsBeforeReconnect = await store.events(many.id, 0);
  assert.equal(eventsBeforeReconnect.filter((e) => e.type === "slice.claimed").length, 7);
  pass("concurrent claims are distinct and capped at six");

  stage = "pool reconnect and event replay";
  const lastCursor = eventsBeforeReconnect.at(-1).cursor;
  await db.close();
  db = await PostgresJobStore.connect(databaseUrl);
  store = new SqlMissionStore(db);
  const eventsAfterReconnect = await store.events(many.id, 0);
  assert.deepEqual(eventsAfterReconnect.map((e) => e.cursor), eventsBeforeReconnect.map((e) => e.cursor));
  assert.deepEqual(await store.events(many.id, lastCursor), []);
  const migrationsAfterReconnect = await db.query("SELECT count(*)::int AS n FROM orloom_schema_migrations");
  assert.equal(migrationsAfterReconnect.rows[0].n, 2);
  pass("event history and migrations persist across pool reconnect");

  stage = "single-slice duplicate claim race";
  await store.configureCapacity(6, digest, future());
  const only = await submit(store, "owner/single-race", "one eligible slice", 100, [slice("only", "one/file.ts")]);
  const race = await Promise.all(Array.from({ length: 16 }, () => store.claim(300, policy)));
  const winners = race.filter((g) => g?.mission.id === only.id);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].slice.id, "only");
  await store.complete(only.id, winners[0].slice.id, winners[0].epoch, winners[0].leaseToken,
    winners[0].capabilityToken, "e".repeat(40), ["proof://candidate"]);
  pass("same slice cannot be claimed twice concurrently");

  stage = "overlapping scope exclusion";
  await store.configureCapacity(2, digest, future());
  const overlap = await submit(store, "owner/scope-lock", "overlap serialization", 200,
    [slice("parent", "src", 100), slice("nested", "src/child.ts", 100, ["parent"])]);
  const parent = await store.claim(300, policy);
  assert(parent && parent.mission.id === overlap.id && parent.slice.id === "parent");
  assert.equal(await store.claim(300, policy), null);
  await store.complete(overlap.id, parent.slice.id, parent.epoch, parent.leaseToken,
    parent.capabilityToken, "f".repeat(40), ["proof://candidate"]);
  assert.equal((await store.getMission(overlap.id)).slices.find((s) => s.id === "nested").status, "waiting_dependency");
  assert.equal(await store.claim(300, policy), null, "unverified parent cannot release its dependent child");
  pass("dependency-waiting child does not quarantine its ready overlapping parent");

  stage = "mixed-case repository scope exclusion";
  await store.configureCapacity(2, digest, future());
  const mixed = await submit(store, "Owner/MixedCase", "case-folded scope lock A", 100,
    [slice("first", "pkg", 100)]);
  const mixedPeer = await submit(store, "owner/mixedcase", "case-folded scope lock B", 100,
    [slice("second", "pkg/sub.ts", 100)]);
  assert.equal((await store.getMission(mixed.id)).mission.repository, "owner/mixedcase");
  const mixedGrant = await store.claim(300, policy);
  assert(mixedGrant && mixedGrant.mission.id === mixed.id);
  assert.equal(await store.claim(300, policy), null, "case-variant repository cannot bypass overlapping active scope");
  await store.complete(mixed.id, mixedGrant.slice.id, mixedGrant.epoch, mixedGrant.leaseToken,
    mixedGrant.capabilityToken, "1".repeat(40), ["proof://candidate"]);
  assert.equal(await store.claim(300, policy), null, "awaiting verification continues to hold case-folded scope");
  assert(mixedPeer.id !== mixed.id);
  pass("mixed-case repository names share canonical scope exclusion");

  stage = "transaction rollback";
  const rollbackMission = await store.submit({
    repository: "owner/rollback", baseSha, objective: "rollback proof",
    acceptance: ["no partial rows"], budgetCents: 100
  });
  await assert.rejects(store.recommendPlan(rollbackMission.id,
    [slice("duplicate", "rollback/one", 50), slice("duplicate", "rollback/two", 50)],
    "trusted-test-harness"));
  const afterRollback = await store.getMission(rollbackMission.id);
  assert.equal(afterRollback.plan, null);
  assert.deepEqual(afterRollback.slices, []);
  assert.deepEqual((await store.events(rollbackMission.id, 0)).map((e) => e.type), ["mission.submitted"]);
  pass("failed recommendation rolls back all plan, slice, and event writes");

  stage = "expiry quarantine and retained reservation";
  await store.configureCapacity(1, digest, future());
  const expiring = await submit(store, "owner/expiry", "lease expiry proof", 100,
    [slice("expires", "pkg", 50)]);
  const expiringGrant = await store.claim(1, policy);
  assert(expiringGrant && expiringGrant.mission.id === expiring.id);
  const reservedBefore = (await store.getMission(expiring.id)).mission.reservedCents;
  assert.equal(reservedBefore, 50);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(await store.expire(), 1);
  const expired = await store.getMission(expiring.id);
  assert.equal(expired.mission.reservedCents, reservedBefore);
  assert.equal(expired.slices.find((s) => s.id === "expires").status, "unknown");
  assert((await store.events(expiring.id, 0)).some((e) => e.type === "slice.lease_expired_unknown"));
  assert.equal(await store.claim(300, policy), null, "UNKNOWN slot remains quarantined at capacity one");
  await store.configureCapacity(2, digest, future());
  const blockedScope = await submit(store, "owner/expiry", "same repo scope remains quarantined", 10,
    [slice("overlap", "pkg/sub/file.ts", 10)]);
  assert.equal(await store.claim(300, policy), null, "UNKNOWN scope remains quarantined");
  const fresh = await submit(store, "owner/fresh", "free slot remains usable", 10,
    [slice("free", "fresh/file.ts", 10)]);
  const freeGrant = await store.claim(300, policy);
  assert(freeGrant && freeGrant.mission.id === fresh.id);
  assert.notEqual(freeGrant.mission.id, blockedScope.id);
  await store.complete(fresh.id, freeGrant.slice.id, freeGrant.epoch, freeGrant.leaseToken,
    freeGrant.capabilityToken, "2".repeat(40), ["proof://candidate"]);
  pass("expiry marks UNKNOWN, retains reservation, and quarantines its slot and scope");

  process.stdout.write("POSTGRES_MISSION_PROOF=PASS\n");
} catch {
  process.stderr.write(`POSTGRES_MISSION_PROOF=FAIL stage=${stage} details_suppressed=true\n`);
  process.exitCode = 1;
} finally {
  if (db) await db.close().catch(() => {});
}
