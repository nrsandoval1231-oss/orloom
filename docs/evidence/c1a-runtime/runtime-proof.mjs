import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { isIPv4 } from "node:net";
import { runInNewContext } from "node:vm";
import { PostgresJobStore } from "./packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "./packages/contracts/src/sql-mission-store.js";
import { loadConfig } from "./packages/config/src/config.js";
import { createControlPlane } from "./apps/control-plane/src/server.js";
import { canonicalJson } from "./packages/judgment/src/canonical.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const digestRef = value => `sha256:${sha(value)}`;
const stageNames = ["bootstrap", "auth", "mission-setup", "first-claim", "episode-a", "episode-b", "candidate", "promotion-fail-closed", "cohort-evidence", "lease-fence", "budget-fence", "reconnect-replay", "cleanup"];
let stage = stageNames[0];
let jobs;
let server;
let address;
const receipts = [];
const backendPids = [];
let pendingJudgmentHold;
let activeJudgmentHold;
let invalidPassSliceId = null;

function configFor(databaseUrl, capacitySlots = 3, targetCheckIds = ["check:trusted-target"]) {
  const targetCheckId = targetCheckIds[0];
  const trustedCheckPolicy = ["check:baseline", "check:recovery", ...targetCheckIds];
  const trustedStrategies = {
    "strategy:baseline": { checkId: "check:baseline", version: "fixture-v1", expectedSignal: "recovery strategy passes", scopeClasses: ["src", "docs"], targetCheckIds },
    "strategy:recovery": { checkId: "check:recovery", version: "fixture-v1", expectedSignal: "trusted recovery check passes", scopeClasses: ["src", "docs"], targetCheckIds },
  };
  const env = {
    ORLOOM_MODE: "cloud",
    PORT: "3000",
    ORLOOM_SESSION_TOKEN: `c1-owner-${randomBytes(24).toString("hex")}`,
    ORLOOM_WORKER_TOKEN: `c1-worker-${randomBytes(24).toString("hex")}`,
    ORLOOM_DATABASE_URL: databaseUrl,
    ORLOOM_PUBLIC_ORIGIN: "https://c1-proof.invalid",
    ORLOOM_HOST: "c1-proof.invalid",
    ORLOOM_MAX_LANES: String(capacitySlots),
    ORLOOM_CAPACITY_SLOTS: String(capacitySlots),
    ORLOOM_CAPACITY_EVIDENCE_VERIFIED: "true",
    ORLOOM_CAPACITY_EVIDENCE_SHA256: sha("c1 disposable isolation fixture"),
    ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT: new Date(Date.now() + 60 * 60_000).toISOString(),
    ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(trustedCheckPolicy),
    ORLOOM_TRUSTED_STRATEGIES_JSON: JSON.stringify(trustedStrategies),
    ORLOOM_WORKER_MAX_PROVIDER_CALLS: "1",
    ORLOOM_WORKER_MAX_INPUT_TOKENS: "1",
    ORLOOM_WORKER_MAX_OUTPUT_TOKENS: "1",
    ORLOOM_WORKER_MAX_WALL_SECONDS: "1",
    ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON: "[\"fixture\"]",
    ORLOOM_WORKER_ALLOWED_MODELS_JSON: "[\"fixture-model\"]",
  };
  return { config: loadConfig(env), targetCheckId };
}

function armJudgmentHold() {
  let started;
  let release;
  const began = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const value = { started, held, release };
  pendingJudgmentHold = value;
  activeJudgmentHold = value;
  return {
    started: began,
    release: () => {
      release();
      if (activeJudgmentHold === value) activeJudgmentHold = undefined;
    },
  };
}

async function controlledJudgment(snapshot) {
  const hold = pendingJudgmentHold;
  if (hold) {
    pendingJudgmentHold = undefined;
    hold.started();
    await hold.held;
    if (activeJudgmentHold === hold) activeJudgmentHold = undefined;
  }
  const failed = snapshot.status === "failed";
  const invalidPass = snapshot.status === "passed" && snapshot.sliceId === invalidPassSliceId;
  const change = failed || invalidPass;
  return {
    version: "orloom.judgment.v1",
    snapshotDigest: sha(canonicalJson(snapshot)),
    source: "deterministic",
    answer: change ? "change_strategy" : (snapshot.status === "blocked" || snapshot.status === "unknown" ? "escalate" : "continue"),
    strategyId: change && !invalidPass ? "strategy:recovery" : null,
    checkId: change && !invalidPass ? "check:recovery" : null,
    policyVersion: "fixture-v1",
    policyDigest: snapshot.recoveryPolicyDigest,
    modelId: null,
    confidence: null,
    usage: null,
  };
}

function call(method, path, { body, cookie, workerToken, lease, origin = true } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { host: "c1-proof.invalid", ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}) };
  if (origin) headers.origin = "https://c1-proof.invalid";
  if (cookie) headers.cookie = cookie;
  if (workerToken) headers.authorization = `Bearer ${workerToken}`;
  if (lease) {
    headers.authorization = `Bearer ${lease.capabilityToken}`;
    headers["x-orloom-lease-token"] = lease.leaseToken;
    headers["x-orloom-lease-epoch"] = String(lease.leaseEpoch);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: address.port, method, path, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value = null;
        if (text) { try { value = JSON.parse(text); } catch { reject(new Error("invalid http response JSON")); return; } }
        resolve({ status: res.statusCode, headers: res.headers, value });
      });
    });
    req.on("error", () => reject(new Error("HTTP fixture request failed")));
    if (payload) req.write(payload);
    req.end();
  });
}

function ownerCall(method, path, cookie, body) {
  return call(method, path, { cookie, body });
}

async function login(ownerToken) {
  const response = await call("POST", "/session", { body: { token: ownerToken } });
  assert.equal(response.status, 204);
  const values = response.headers["set-cookie"];
  assert.ok(Array.isArray(values) && values.length === 1);
  const setCookie = values[0];
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  return setCookie.split(";", 1)[0];
}

async function workerClaim(workerToken) {
  const response = await call("POST", "/api/worker/claim", { body: {}, workerToken, origin: false });
  assert.equal(response.status, 200);
  assert.equal(response.value.protocol, "orloom.worker-lease.v1");
  return response.value;
}

async function policyFor(lease) {
  const response = await call("GET", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/recovery-policy`, { lease, origin: false });
  assert.equal(response.status, 200);
  assert.equal(response.value.version, "orloom.recovery-policy.v1");
  return response.value;
}

function fixtureWorkspace() { return { source: "const answer = 41;\n" }; }
function runFixedCheck(workspace) {
  const actual = runInNewContext(`${workspace.source}\nanswer;`);
  const receipt = Buffer.from(JSON.stringify({ check: "answer-exactly-42", expected: 42, actual, exitCode: actual === 42 ? 0 : 1 }));
  return { actual, exitCode: actual === 42 ? 0 : 1, receipt };
}
function applyApprovedRecovery(workspace, strategyId) {
  assert.equal(strategyId, "strategy:recovery");
  assert.equal((workspace.source.match(/answer = 41;/g) ?? []).length, 1, "approved patch is restricted to the known fixture state");
  workspace.source = workspace.source.replace("answer = 41;", "answer = 42;");
}
function progressFor(lease, policy, eventId, ordinal, strategyId, check, targetCheckId = "check:trusted-target") {
  const passed = check.exitCode === 0;
  const checkId = policy.strategies[strategyId].checkId;
  const value = {
    version: "orloom.progress.v1",
    eventId,
    missionId: lease.mission.id,
    sliceId: lease.slice.id,
    leaseEpoch: lease.leaseEpoch,
    ordinal,
    planDigest: policy.planDigest,
    trustedCheckPolicyDigest: policy.trustedCheckPolicyDigest,
    recoveryPolicyDigest: policy.recoveryPolicyDigest,
    phase: "trusted_check",
    status: passed ? "passed" : "failed",
    reasonCode: passed ? "check_passed" : "check_failed",
    strategyId,
    targetCheckId,
    checkId,
    counters: { providerCalls: 0, inputTokens: 0, outputTokens: 0, wallMs: 1 },
    evidenceRefs: [digestRef(check.receipt)],
  };
  receipts.push({ eventId, receiptBase64: check.receipt.toString("base64"), receiptSha256: sha(check.receipt) });
  return value;
}

async function postProgress(lease, value) {
  return call("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, { body: value, lease, origin: false });
}

async function assertRecoveryEpisode(lease, policy, prefix) {
  const workspace = fixtureWorkspace();
  const failedCheck = runFixedCheck(workspace);
  assert.equal(failedCheck.exitCode, 1, "the fixed check fails against the initial fixture");
  const progressEvent = progressFor(lease, policy, `${prefix}-baseline-failed`, 1, "strategy:baseline", failedCheck);
  const gap = await postProgress(lease, { ...progressEvent, eventId: `${prefix}-ordinal-gap`, ordinal: 3 });
  assert.equal(gap.status, 409, "ordinal gap is rejected before the legitimate first event");
  const wrongCapability = { ...lease, capabilityToken: "wrong-capability" };
  assert.equal((await postProgress(wrongCapability, progressEvent)).status, 409, "wrong capability is rejected before event storage");
  const failed = await postProgress(lease, progressEvent);
  assert.equal(failed.status, 200);
  assert.equal(failed.value.judgment.answer, "change_strategy");
  assert.equal(failed.value.judgment.strategyId, "strategy:recovery");
  const snapshot = failed.value.snapshot;
  assert.equal(failed.value.judgment.snapshotDigest, sha(canonicalJson(snapshot)), "decision hash binds the canonical persisted snapshot");
  assert.equal(snapshot.missionBudgetCents, 90_000);
  assert.equal(snapshot.sliceBudgetCents, 10_000);
  assert.equal(snapshot.reservedBudgetCents, 20_000);
  assert.deepEqual(snapshot.reportedUsage, progressEvent.counters);
  assert.deepEqual(snapshot.evidenceRefs, progressEvent.evidenceRefs);
  const replay = await postProgress(lease, progressEvent);
  assert.equal(replay.status, 200);
  assert.equal(replay.value.duplicate, true);
  const reordered = Object.fromEntries(Object.entries(progressEvent).reverse());
  reordered.counters = { wallMs: progressEvent.counters.wallMs, outputTokens: progressEvent.counters.outputTokens, inputTokens: progressEvent.counters.inputTokens, providerCalls: progressEvent.counters.providerCalls };
  assert.equal((await postProgress(lease, reordered)).value.duplicate, true, "canonical replay tolerates equivalent JSON key ordering");
  assert.equal((await postProgress(lease, { ...progressEvent, status: "passed", reasonCode: "check_passed" })).status, 409);
  applyApprovedRecovery(workspace, failed.value.action.strategyId);
  const passedCheck = runFixedCheck(workspace);
  assert.equal(passedCheck.exitCode, 0, "the same fixed check passes only after the authorized fixture repair");
  const recoveryEvent = progressFor(lease, policy, `${prefix}-recovery-passed`, 2, "strategy:recovery", passedCheck);
  const recovered = await postProgress(lease, recoveryEvent);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.value.judgment.answer, "continue");
  assert.equal(recovered.value.snapshot.revision, 2);
  return { baselineEventId: progressEvent.eventId, successEventId: recoveryEvent.eventId, baselineEvidenceRef: progressEvent.evidenceRefs[0], successEvidenceRef: recoveryEvent.evidenceRefs[0] };
}

async function createMission(ownerCookie, repository, sliceIds, scopesBySlice = {}) {
  const created = await ownerCall("POST", "/api/missions", ownerCookie, {
    repository,
    baseSha: sha(`${repository}-base`).slice(0, 40),
    objective: "Validate a fixed recovery fixture through authenticated mission APIs.",
    acceptance: ["The deterministic recovery decision matches the approved strategy."],
    budgetCents: 90_000,
  });
  assert.equal(created.status, 201);
  const slices = sliceIds.map((id, index) => ({
    id,
    objective: `Fixed recovery fixture ${id}`,
    dependencies: [],
    owner: "fixture-owner",
    scopes: scopesBySlice[id] ?? [`src/c1-proof/${id}`],
    checks: ["strategy:baseline", "strategy:recovery"],
    budgetCents: 10_000,
  }));
  const recommendation = await ownerCall("POST", `/api/missions/${created.value.id}/plan`, ownerCookie, { recommendedBy: "owner-proof", slices });
  assert.equal(recommendation.status, 201);
  const approved = await ownerCall("POST", `/api/missions/${created.value.id}/approve`, ownerCookie, {});
  assert.equal(approved.status, 200);
  const current = await ownerCall("GET", `/api/missions/${created.value.id}`, ownerCookie);
  assert.equal(current.status, 200);
  return { id: created.value.id, slices: current.value.plan.slices };
}

async function main() {
  const pgHost = process.env.ORLOOM_PG_HOST;
  const passwordFile = process.env.ORLOOM_PG_PASSWORD_FILE;
  const databaseName = process.env.ORLOOM_PG_DATABASE;
  const auxiliaryDatabaseName = process.env.ORLOOM_PG_AUX_DATABASE;
  const octets = String(pgHost ?? "").split(".").map(Number);
  const privateHost = isIPv4(pgHost) && ((octets[0] === 10) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (!privateHost || passwordFile !== "/run/secrets/pg-password-test" || databaseName !== "mission_proof_03" || auxiliaryDatabaseName !== "mission_proof_aux_03") throw new Error("proof environment identity mismatch");
  let password = (await readFile(passwordFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("test database credential format invalid");
  const databaseUrl = `postgresql://mission_app:${password}@${pgHost}:5432/${databaseName}`;
  stage = "bootstrap";
  const { config } = configFor(databaseUrl);
  jobs = await PostgresJobStore.connect(databaseUrl);
  assert.equal(await jobs.ready(), true);
  const [connectionA, connectionB] = await Promise.all([
    jobs.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.2)"),
    jobs.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.2)"),
  ]);
  assert.notEqual(connectionA.rows[0].pid, connectionB.rows[0].pid, "the pool must use distinct concurrent PostgreSQL backends");
  backendPids.push(Number(connectionA.rows[0].pid), Number(connectionB.rows[0].pid));
  let missionStore = new SqlMissionStore(jobs);
  await missionStore.configureCapacity(config.capacitySlots, config.capacityEvidenceDigest, config.capacityEvidenceExpiresAt);
  server = createControlPlane(config, jobs, missionStore, controlledJudgment);
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("test control plane failed to listen")));
    server.listen(0, "127.0.0.1", resolve);
  });
  address = server.address();
  assert.ok(address && typeof address === "object");

  stage = "auth";
  const ownerCookie = await login(config.sessionToken);
  const health = await call("GET", "/health", { origin: false });
  assert.equal(health.status, 200);
  const unauthorized = await ownerCall("POST", "/api/missions", "orloom_session=invalid", {});
  assert.equal(unauthorized.status, 401);

  stage = "mission-setup";
  const workerToken = config.workerToken;
  const first = await createMission(ownerCookie, "fixture/recovery-proof", ["episode-a", "episode-b"], {
    "episode-a": ["src/z", "docs/a"], "episode-b": ["docs/b", "src/y"],
  });
  const planDigest = sha(JSON.stringify(first.slices));

  stage = "first-claim";
  const leaseA = await workerClaim(workerToken);
  const leaseB = await workerClaim(workerToken);
  assert.equal(leaseA.mission.id, first.id);
  assert.equal(leaseB.mission.id, first.id);
  assert.deepEqual([leaseA.slice.id, leaseB.slice.id].sort(), ["episode-a", "episode-b"]);
  assert.equal(leaseA.planDigest, planDigest);
  assert.equal(leaseB.planDigest, planDigest);
  const policyA = await policyFor(leaseA);
  const policyB = await policyFor(leaseB);
  assert.equal(policyA.recoveryPolicyDigest, policyB.recoveryPolicyDigest);

  stage = "concurrent-progress";
  const episodeA = await assertRecoveryEpisode(leaseA, policyA, "a");
  stage = "episode-b";
  const episodeB = await assertRecoveryEpisode(leaseB, policyB, "b");
  assert.notEqual(leaseA.slice.id, leaseB.slice.id);
  assert.ok(episodeA.baselineEventId && episodeB.successEventId);

  stage = "candidate";
  const lessonResponse = await ownerCall("GET", `/api/missions/${first.id}/lessons`, ownerCookie);
  assert.equal(lessonResponse.status, 200);
  const candidate = lessonResponse.value.find(item => item.status === "candidate");
  assert.ok(candidate, "two distinct passing recovery episodes must create a candidate lesson");
  assert.equal(candidate.repository, "fixture/recovery-proof");
  assert.equal(candidate.cohort, "docs");
  assert.equal(candidate.fromCheckId, "check:trusted-target");
  assert.equal(candidate.strategyId, "strategy:recovery");
  assert.equal(candidate.metric, "trusted_check_pass_rate");
  assert.equal(candidate.direction, "increase");
  assert.equal(candidate.evidenceEventIds.length, 4);
  assert.equal(candidate.baseline.failed, 2);
  assert.equal(candidate.outcome.passed, 2);
  assert.match(candidate.challengeDigest, /^[a-f0-9]{64}$/);
  const receiptIds = [episodeA.baselineEventId, episodeA.successEventId, episodeB.baselineEventId, episodeB.successEventId];
  assert.deepEqual([...candidate.evidenceEventIds].sort(), [...receiptIds].sort());
  const durable = await jobs.query("SELECT event_id,progress FROM mission_recovery_progress WHERE event_id=ANY($1::text[]) ORDER BY event_id", [receiptIds]);
  assert.equal(durable.rows.length, 4);
  const refs = new Map([[episodeA.baselineEventId, episodeA.baselineEvidenceRef], [episodeA.successEventId, episodeA.successEvidenceRef], [episodeB.baselineEventId, episodeB.baselineEvidenceRef], [episodeB.successEventId, episodeB.successEvidenceRef]]);
  for (const row of durable.rows) {
    const progress = row.progress;
    assert.equal(progress.evidenceRefs[0], refs.get(row.event_id));
    assert.ok((progress.status === "failed" && progress.strategyId === "strategy:baseline") || (progress.status === "passed" && progress.strategyId === "strategy:recovery"));
  }
  const provenance = {
    repository: candidate.repository,
    cohort: candidate.cohort,
    fromCheckId: candidate.fromCheckId,
    strategyId: candidate.strategyId,
    policyVersion: candidate.policyVersion,
    policyDigest: candidate.policyDigest,
    evidenceEventIds: [...candidate.evidenceEventIds].sort(),
    metric: candidate.metric,
    direction: candidate.direction,
    baseline: candidate.baseline,
    outcome: candidate.outcome,
  };
  assert.equal(candidate.challengeDigest, sha(canonicalJson(provenance)));
  const challenge = {
    version: "orloom.lesson-challenge.v1",
    lessonId: candidate.id,
    ...provenance,
    metric: candidate.metric,
    direction: candidate.direction,
    baseline: { failed: 2, observed: 2 },
    outcome: { passed: 2, observed: 2 },
  };

  stage = "promotion-fail-closed";
  const promotion = await ownerCall("POST", `/api/lessons/${candidate.id}/promote`, ownerCookie, challenge);
  assert.equal(promotion.status, 503);
  assert.deepEqual(promotion.value, { error: "Independent lesson verification is unavailable; candidate remains unpromoted" });
  const afterPromotionAttempt = await ownerCall("GET", `/api/missions/${first.id}/lessons`, ownerCookie);
  assert.equal(afterPromotionAttempt.value.find(item => item.id === candidate.id)?.status, "candidate");

  stage = "lease-fence";
  await jobs.query("UPDATE mission_slices SET lease_expires_at=now()-interval '1 second' WHERE mission_id=$1 AND id=$2 AND lease_epoch=$3", [first.id, leaseA.slice.id, leaseA.leaseEpoch]);
  assert.equal(await missionStore.expire(new Date(Date.now() + 1000)), 1);
  const staleFixtureCheck = runFixedCheck(fixtureWorkspace());
  assert.equal(staleFixtureCheck.exitCode, 1);
  const stale = await postProgress(leaseA, progressFor(leaseA, policyA, "expired-lease-progress", 3, "strategy:baseline", staleFixtureCheck));
  assert.equal(stale.status, 409);

  stage = "budget-fence";
  const budgetMission = await createMission(ownerCookie, "fixture/budget-fence-proof", ["budget-fenced"]);
  const budgetLease = await workerClaim(workerToken);
  assert.equal(budgetLease.mission.id, budgetMission.id);
  const budgetPolicy = await policyFor(budgetLease);
  const budgetCheck = runFixedCheck(fixtureWorkspace());
  assert.equal(budgetCheck.exitCode, 1);
  const budgetEvent = progressFor(budgetLease, budgetPolicy, "budget-fence-progress", 1, "strategy:baseline", budgetCheck);
  const hold = armJudgmentHold();
  const inFlight = postProgress(budgetLease, budgetEvent);
  await hold.started;
  const prepared = await jobs.query("SELECT pg_backend_pid() AS pid,event_id,progress,snapshot,decision_status FROM mission_recovery_progress WHERE event_id=$1", [budgetEvent.eventId]);
  assert.equal(prepared.rows.length, 1, "the second pool connection sees the committed prepared row during adapter wait");
  backendPids.push(Number(prepared.rows[0].pid));
  assert.equal(prepared.rows[0].decision_status, "prepared");
  assert.deepEqual(prepared.rows[0].snapshot.reportedUsage, budgetEvent.counters);
  assert.deepEqual(prepared.rows[0].snapshot.evidenceRefs, budgetEvent.evidenceRefs);
  assert.equal(prepared.rows[0].snapshot.missionBudgetCents, 90_000);
  assert.equal(prepared.rows[0].snapshot.sliceBudgetCents, 10_000);
  assert.equal(prepared.rows[0].snapshot.reservedBudgetCents, 10_000);
  const beforeFence = await jobs.query("SELECT s.capacity_slot,s.scopes,m.reserved_cents FROM mission_slices s JOIN missions m ON m.id=s.mission_id WHERE s.mission_id=$1 AND s.id=$2", [budgetMission.id, budgetLease.slice.id]);
  assert.equal(beforeFence.rows.length, 1);
  const retainedSlot = Number(beforeFence.rows[0].capacity_slot);
  const retainedScopes = beforeFence.rows[0].scopes;
  const retainedReservedCents = Number(beforeFence.rows[0].reserved_cents);
  assert.ok(retainedSlot > 0, "the active lease owns a persisted capacity slot");
  assert.deepEqual(retainedScopes, budgetLease.slice.scopes);
  assert.equal(retainedReservedCents, 10_000);
  const changedBudget = await jobs.query("UPDATE missions SET budget_cents=budget_cents+1 WHERE id=$1 RETURNING budget_cents", [budgetMission.id]);
  assert.equal(Number(changedBudget.rows[0].budget_cents), 90_001, "only the disposable mission budget changed while the adapter was waiting");
  hold.release();
  assert.equal((await inFlight).status, 409, "a judgment cannot commit against a changed authoritative snapshot");
  const fencedRow = await jobs.query("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [budgetEvent.eventId]);
  assert.equal(fencedRow.rows[0].decision_status, "unknown");
  assert.equal(fencedRow.rows[0].action, null);
  const fencedMission = await missionStore.getMission(budgetMission.id);
  assert.equal(fencedMission.mission.budgetCents, 90_001);
  assert.equal(fencedMission.mission.reservedCents, 10_000);
  assert.equal(fencedMission.slices.find(item => item.id === "budget-fenced").status, "unknown");
  const afterFence = await jobs.query("SELECT s.capacity_slot,s.scopes,m.reserved_cents FROM mission_slices s JOIN missions m ON m.id=s.mission_id WHERE s.mission_id=$1 AND s.id=$2", [budgetMission.id, budgetLease.slice.id]);
  assert.equal(Number(afterFence.rows[0].capacity_slot), retainedSlot, "UNKNOWN retains the assigned capacity slot");
  assert.deepEqual(afterFence.rows[0].scopes, retainedScopes, "UNKNOWN retains its scope reservation");
  assert.equal(Number(afterFence.rows[0].reserved_cents), retainedReservedCents, "UNKNOWN retains the mission budget reservation");
  assert.equal(await missionStore.claim(300, config.trustedCheckPolicyDigest, undefined, config.recoveryPolicyDigest), null, "the unknown slice remains quarantined");

  stage = "reconnect-replay";
  const beforeClose = await ownerCall("GET", `/api/missions/${first.id}/events?after=0`, ownerCookie);
  assert.equal(beforeClose.status, 200);
  const candidateEvent = beforeClose.value.find(event => event.type === "lesson.candidate" && event.data.lessonId === candidate.id);
  const expiredEvent = beforeClose.value.find(event => event.type === "slice.lease_expired_unknown" && event.data.sliceId === leaseA.slice.id);
  assert.ok(candidateEvent && expiredEvent);
  const budgetEvents = await ownerCall("GET", `/api/missions/${budgetMission.id}/events?after=0`, ownerCookie);
  const budgetUnknownEvent = budgetEvents.value.find(event => event.type === "slice.judgment_unknown" && event.data.eventId === budgetEvent.eventId);
  assert.ok(budgetUnknownEvent, "budget-fenced decision is durably recorded as UNKNOWN");
  await new Promise(resolve => server.close(resolve));
  server = undefined;
  await jobs.close();
  jobs = undefined;
  const reopened = await PostgresJobStore.connect(databaseUrl);
  jobs = reopened;
  assert.equal(await jobs.ready(), true);
  const reopenedStore = new SqlMissionStore(jobs);
  missionStore = reopenedStore;
  server = createControlPlane(config, jobs, reopenedStore, controlledJudgment);
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("reconnected test control plane failed to listen")));
    server.listen(0, "127.0.0.1", resolve);
  });
  address = server.address();
  assert.ok(address && typeof address === "object");
  const freshCookie = await login(config.sessionToken);
  const replay = await ownerCall("GET", `/api/missions/${first.id}/events?after=${candidateEvent.cursor - 1}`, freshCookie);
  assert.equal(replay.status, 200);
  assert.ok(replay.value.some(event => event.cursor === candidateEvent.cursor && event.type === "lesson.candidate"));
  assert.ok(replay.value.some(event => event.cursor === expiredEvent.cursor && event.type === "slice.lease_expired_unknown"));
  const durableLessons = await ownerCall("GET", `/api/missions/${first.id}/lessons`, freshCookie);
  assert.equal(durableLessons.value.find(item => item.id === candidate.id)?.status, "candidate");
  const budgetReplay = await ownerCall("GET", `/api/missions/${budgetMission.id}/events?after=${budgetUnknownEvent.cursor - 1}`, freshCookie);
  assert.ok(budgetReplay.value.some(event => event.cursor === budgetUnknownEvent.cursor && event.type === "slice.judgment_unknown"));

  // Separate disposable database runs cohort and UNKNOWN-pass scenarios without contaminating the candidate proof.
  await new Promise(resolve => server.close(resolve));
  server = undefined;
  await jobs.close();
  jobs = undefined;
  stage = "cohort-evidence";
  const auxiliaryUrl = `postgresql://mission_app:${password}@${pgHost}:5432/${auxiliaryDatabaseName}`;
  const auxiliary = configFor(auxiliaryUrl, 6);
  jobs = await PostgresJobStore.connect(auxiliaryUrl);
  assert.equal(await jobs.ready(), true);
  missionStore = new SqlMissionStore(jobs);
  await missionStore.configureCapacity(auxiliary.config.capacitySlots, auxiliary.config.capacityEvidenceDigest, auxiliary.config.capacityEvidenceExpiresAt);
  server = createControlPlane(auxiliary.config, jobs, missionStore, controlledJudgment);
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("auxiliary proof server failed to listen")));
    server.listen(0, "127.0.0.1", resolve);
  });
  address = server.address();
  assert.ok(address && typeof address === "object");
  const auxiliaryCookie = await login(auxiliary.config.sessionToken);
  const auxiliaryWorker = auxiliary.config.workerToken;

  const mixedMission = await createMission(auxiliaryCookie, "fixture/mixed-cohort-proof", ["mixed-src", "mixed-docs"], {
    "mixed-src": ["src/recovery/mixed-src"], "mixed-docs": ["docs/recovery/mixed-docs"],
  });
  const mixedLeases = [await workerClaim(auxiliaryWorker), await workerClaim(auxiliaryWorker)];
  for (const lease of mixedLeases) {
    assert.equal(lease.mission.id, mixedMission.id);
    const policy = await policyFor(lease);
    await assertRecoveryEpisode(lease, policy, `mixed-${lease.slice.id}`);
  }
  const mixedLessons = await ownerCall("GET", `/api/missions/${mixedMission.id}/lessons`, auxiliaryCookie);
  assert.equal(mixedLessons.status, 200);
  assert.equal(mixedLessons.value.some(item => item.status === "candidate"), false, "different docs/src cohorts remain incomparable in SQL");

  for (const order of [["unknown-first", "valid-second"], ["valid-first", "unknown-second"]]) {
    const unknownIndex = order.findIndex(value => value.startsWith("unknown"));
    const sliceIds = order.map((kind, index) => `episode-${index}-${kind}`);
    const unknownSlice = sliceIds[unknownIndex];
    const unresolvedMission = await createMission(auxiliaryCookie, `fixture/unresolved-pass-${order[0]}`, sliceIds);
    const leases = [await workerClaim(auxiliaryWorker), await workerClaim(auxiliaryWorker)];
    for (let index = 0; index < leases.length; index++) {
      const lease = leases[index];
      assert.equal(lease.mission.id, unresolvedMission.id);
      const policy = await policyFor(lease);
      const workspace = fixtureWorkspace();
      const initial = runFixedCheck(workspace);
      const failedEvent = progressFor(lease, policy, `${order[index]}-baseline-${randomUUID()}`, 1, "strategy:baseline", initial);
      const failed = await postProgress(lease, failedEvent);
      assert.equal(failed.status, 200);
      assert.equal(failed.value.action.strategyId, "strategy:recovery");
      applyApprovedRecovery(workspace, failed.value.action.strategyId);
      const repaired = runFixedCheck(workspace);
      const passedEvent = progressFor(lease, policy, `${order[index]}-passed-${randomUUID()}`, 2, "strategy:recovery", repaired);
      invalidPassSliceId = lease.slice.id === unknownSlice ? lease.slice.id : null;
      const passed = await postProgress(lease, passedEvent);
      invalidPassSliceId = null;
      if (lease.slice.id === unknownSlice) {
        assert.equal(passed.status, 409);
        const unresolved = await jobs.query("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [passedEvent.eventId]);
        assert.equal(unresolved.rows[0].decision_status, "unknown");
        assert.equal(unresolved.rows[0].action, null);
      } else {
        assert.equal(passed.status, 200);
        assert.equal(passed.value.judgment.answer, "continue");
      }
    }
    const lessons = await ownerCall("GET", `/api/missions/${unresolvedMission.id}/lessons`, auxiliaryCookie);
    assert.equal(lessons.status, 200);
    assert.equal(lessons.value.some(item => item.status === "candidate"), false, `${unknownSlice} unresolved pass cannot be paired as committed evidence`);
  }

  stage = "cleanup";
  process.stdout.write(`C1A_REAL_POSTGRES_HTTP_PROOF=PASS checks=auth,policy_binding,executable_failure_repair_same_check_passes,two_slice_candidate_persistence,owner_promotion_fail_closed,unresolved_pass_both_orders,mixed_cohort_exclusion,unsorted_scope_candidate,ordinal_gap,wrong_capability,idempotent_replay,conflicting_replay,lease_expiry_unknown_quarantine,budget_snapshot_race_unknown_quarantine,concurrent_backend_pids,pool_reconnect,event_cursor_replay providers=0 backend_pids=${JSON.stringify(backendPids)} receipts=${JSON.stringify(receipts)}\n`);
  password = "";
}

try { await main(); }
catch {
  process.stderr.write(`C1_REAL_POSTGRES_HTTP_PROOF=FAIL stage=${stage} details_suppressed=true\n`);
  process.exitCode = 1;
} finally {
  if (activeJudgmentHold) activeJudgmentHold.release();
  if (server) await new Promise(resolve => server.close(resolve));
  if (jobs) await jobs.close().catch(() => undefined);
}
