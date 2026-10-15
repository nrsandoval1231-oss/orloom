import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createControlPlane } from "../dist/apps/control-plane/src/server.js";
import { PostgresJobStore } from "../dist/packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "../dist/packages/contracts/src/sql-mission-store.js";

// Explicit isolated test database only. No worker/provider/verifier is launched.
const url = process.env.ORLOOM_READINESS_TEST_DATABASE_URL;
if (!url) throw new Error("Explicit fresh isolated readiness test database required");
const first = await PostgresJobStore.connect(url), second = await PostgresJobStore.connect(url);
const store = new SqlMissionStore(first), restarted = new SqlMissionStore(second);
const checks = ["check:unit"], policy = createHash("sha256").update(JSON.stringify(checks)).digest("hex");
const config = { mode: "local", port: 0, sessionToken: "synthetic-owner-only", workerToken: "synthetic-worker-only", maxLanes: 1, capacitySlots: 0, trustedCheckPolicy: checks, trustedCheckPolicyDigest: policy };
let server;
const open = async current => {
  server = createControlPlane(config, first, current);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async () => { if (server) { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server = null; } };
const get = async (base, id) => {
  const path = `${base}/api/missions/${id}/loom`;
  assert.equal((await fetch(path)).status, 401);
  const response = await fetch(path, { headers: { cookie: `orloom_session=${config.sessionToken}` } });
  assert.equal(response.status, 200);
  return response.json();
};
try {
  await store.configureCapacity(1, policy, new Date(Date.now() + 300_000).toISOString());
  const mission = await store.submit({ repository: "fixture/readiness", baseSha: "a".repeat(40), objective: "Synthetic durable owner view", acceptance: ["Truthful state"], budgetCents: 100 });
  await store.recommendPlan(mission.id, [{ id: "slice", objective: "Observe durable state", owner: "owner", dependencies: [], scopes: ["src"], checks, budgetCents: 100 }], "fixture-owner");
  await store.approvePlan(mission.id);
  const grant = await store.claim(1, policy, checks); assert(grant);
  const identity = { missionId: mission.id, sliceId: "slice", leaseEpoch: grant.epoch, controllerRunId: "b".repeat(64) };
  let base = await open(store);
  const before = await get(base, mission.id);
  assert.equal(before.projection.readiness.state, "unverified");
  assert.equal(before.projection.cancellation.state, "none");
  await store.expire(new Date(Date.now() + 60_000));
  await store.requestCancel(mission.id, "fixture-stop", "Owner stops expired no-runtime task");
  const uncertain = await get(base, mission.id);
  assert.equal(uncertain.projection.cancellation.state, "quarantined-unknown");
  assert.equal(uncertain.projection.closed, false);
  await close(); base = await open(restarted);
  assert.deepEqual(await get(base, mission.id), uncertain, "new store and HTTP process reconstruct the same durable view");
  assert.equal(await restarted.settleCancellationBeforeRuntime(identity), "settled");
  const settled = await get(base, mission.id);
  assert.equal(settled.projection.cancellation.state, "pre-runtime-settled");
  assert.equal(settled.projection.closed, false);
  assert(settled.projection.events.some(event => event.type === "slice.cancellation_settled_before_runtime" && event.label === "Cancelled before runtime start"));
  const count = (await restarted.events(mission.id, 0)).length;
  await close(); base = await open(new SqlMissionStore(first));
  assert.deepEqual(await get(base, mission.id), settled);
  assert.equal((await restarted.events(mission.id, 0)).length, count, "reads create no synthetic events");
  assert.equal((await restarted.getMission(mission.id)).mission.reservedCents, 100);
  console.log(JSON.stringify({ status: "PASS", database: "isolated actual PostgreSQL", connections: 2, httpRestarts: 2, ownerAuthentication: true, expiredUnknown: true, preRuntimeSettlement: true, readSideEffects: 0, reservedCents: 100, providerCalls: 0, workerExecutions: 0, limitations: ["Synthetic local configuration; runtime/provider/image readiness unverified", "No live verification, delivery or deployment"] }, null, 2));
} finally { await close(); await first.close(); await second.close(); }
