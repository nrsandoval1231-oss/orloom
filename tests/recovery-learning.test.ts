import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Fetch } from "@typesafe-ai/sdk";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { SqlMissionStore, TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { JevClient } from "../packages/judgment/src/jev-client.js";
import { createJevRecoveryAdapter } from "../packages/judgment/src/jev-adapter.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import type { RecoveryJudgmentAdapter } from "../packages/governor/src/governor.js";
import type { DecisionSnapshotV1 } from "../packages/judgment/src/types.js";
import { loadConfig } from "../packages/config/src/config.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digestRef = (receipt: Uint8Array) => `sha256:${sha(receipt)}`;
const targetCheckId = "target:answer-42";
const modelId = "fixture-jevt-model-v1";
const strategies = {
  "strategy:baseline": { checkId: "check:baseline", version: "fixture-v1", expectedSignal: "the fixture returns 42", scopeClasses: ["src"], targetCheckIds: [targetCheckId] },
  "strategy:recovery": { checkId: "check:recovery", version: "fixture-v1", expectedSignal: "the same fixture check returns 42 after the approved repair", scopeClasses: ["src"], targetCheckIds: [targetCheckId] },
};

function config(targetCheckIds: string[] = [targetCheckId], scopeClasses: string[] = ["src"]) {
  const trustedStrategies = {
    ...strategies,
    "strategy:baseline": { ...strategies["strategy:baseline"], targetCheckIds, scopeClasses },
    "strategy:recovery": { ...strategies["strategy:recovery"], targetCheckIds, scopeClasses },
  };
  return loadConfig({
    ORLOOM_MODE: "local", PORT: "3000", ORLOOM_SESSION_TOKEN: "owner-fixture-session", ORLOOM_WORKER_TOKEN: "worker-fixture-bootstrap",
    ORLOOM_MAX_LANES: "3", ORLOOM_CAPACITY_SLOTS: "3", ORLOOM_CAPACITY_EVIDENCE_VERIFIED: "true",
    ORLOOM_CAPACITY_EVIDENCE_SHA256: sha("isolated PGlite recovery test fixture"), ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
    ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(["check:baseline", "check:recovery", ...targetCheckIds]), ORLOOM_TRUSTED_STRATEGIES_JSON: JSON.stringify(trustedStrategies),
    ORLOOM_WORKER_MAX_PROVIDER_CALLS: "1", ORLOOM_WORKER_MAX_INPUT_TOKENS: "1", ORLOOM_WORKER_MAX_OUTPUT_TOKENS: "1", ORLOOM_WORKER_MAX_WALL_SECONDS: "1",
    ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON: "[\"fixture\"]", ORLOOM_WORKER_ALLOWED_MODELS_JSON: "[\"fixture-model\"]",
  });
}

function jevTransport(options: { holdFirstRecoveryChoice?: boolean } = {}) {
  let callCount = 0;
  let choiceStarted!: () => void;
  const started = new Promise<void>(resolve => { choiceStarted = resolve; });
  let releaseChoice!: () => void;
  const release = new Promise<void>(resolve => { releaseChoice = resolve; });
  let held = false;
  let terminal = false;
  const fetch: Fetch = async (input, init) => {
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    const request = JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, string> } } };
    const criteria = request.questions.decision.criteria;
    callCount++;
    let selected = terminal ? "escalate" : Object.hasOwn(criteria, "strategy_1") ? "strategy_1" : "continue";
    if (options.holdFirstRecoveryChoice && !held && selected === "strategy_1") {
      held = true;
      choiceStarted();
      await release;
    }
    const probabilities = Object.fromEntries(Object.keys(criteria).map(key => [key, key === selected ? 1 : 0]));
    return new Response(JSON.stringify({
      model: modelId,
      answers: { decision: { type: "choice", choice: selected, confidence: 1, probabilities } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, started, releaseChoice, calls: () => callCount, setTerminal: (value: boolean) => { terminal = value; } };
}

async function setup(options: { holdFirstRecoveryChoice?: boolean; judgmentAdapter?: RecoveryJudgmentAdapter; targetCheckIds?: string[]; scopeClasses?: string[] } = {}) {
  const db = new PGlite();
  await db.exec(await readFile("db/migrations/001_initial.sql", "utf8"));
  await db.exec(await readFile("db/migrations/002_missions.sql", "utf8"));
  await db.exec(await readFile("db/migrations/003_recovery.sql", "utf8"));
  let transactionGate = Promise.resolve();
  const sql: TransactionalSql = {
    query: async (text, params) => await db.query(text, params as never) as never,
    transaction: async work => {
      let release!: () => void;
      const prior = transactionGate;
      transactionGate = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try {
        await db.exec("BEGIN");
        const result = await work({ query: async (text, params) => await db.query(text, params as never) as never });
        await db.exec("COMMIT");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      } finally { release(); }
    },
  };
  let store = new SqlMissionStore(sql);
  const cfg = config(options.targetCheckIds, options.scopeClasses);
  await store.configureCapacity(3, cfg.capacityEvidenceDigest!, cfg.capacityEvidenceExpiresAt!);
  const transport = jevTransport(options);
  const jev = new JevClient({ apiKey: "fixture-only-key", modelId, allowedModelIds: new Set([modelId]), limits: { maxInputBytes: 64_000, maxResponseBytes: 32_000, timeoutMs: 2_000 }, fetch: transport.fetch });
  const jobs = new MemoryJobStore();
  const judgmentAdapter = options.judgmentAdapter ?? createJevRecoveryAdapter(jev);
  let server = createControlPlane(cfg, jobs, store, judgmentAdapter);
  let base = "";
  const listen = async () => {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const addr = server.address(); assert(addr && typeof addr !== "string"); base = `http://127.0.0.1:${addr.port}`;
  };
  await listen();
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let value: any = null;
    if (text) value = JSON.parse(text);
    return { status: response.status, headers: response.headers, value };
  };
  const login = await request("POST", "/session", { token: cfg.sessionToken });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie);
  return {
    db, get store() { return store; }, cfg, cookie, request, transport,
    reconnect: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store = new SqlMissionStore(sql);
      server = createControlPlane(cfg, jobs, store, judgmentAdapter);
      await listen();
      const login = await request("POST", "/session", { token: cfg.sessionToken }); assert.equal(login.status, 204);
    },
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await db.close(); },
  };
}

async function createMission(ctx: Awaited<ReturnType<typeof setup>>, repository: string, sliceIds: string[], scopeBySlice: Record<string, string[]> = {}) {
  const { status, value } = await ctx.request("POST", "/api/missions", {
    repository, baseSha: sha(`${repository}-base`).slice(0, 40), objective: "Exercise a real fixed recovery check and durable lesson policy.", acceptance: ["The same fixed check succeeds after an approved repair."], budgetCents: 90_000,
  }, { cookie: ctx.cookie });
  assert.equal(status, 201);
  const slices = sliceIds.map(id => ({ id, objective: `Run fixed check for ${id}`, dependencies: [], owner: "fixture-owner", scopes: scopeBySlice[id] ?? [`src/recovery/${id}`], checks: ["strategy:baseline", "strategy:recovery"], budgetCents: 10_000 }));
  assert.equal((await ctx.request("POST", `/api/missions/${value.id}/plan`, { recommendedBy: "owner-fixture", slices }, { cookie: ctx.cookie })).status, 201);
  assert.equal((await ctx.request("POST", `/api/missions/${value.id}/approve`, {}, { cookie: ctx.cookie })).status, 200);
  return value.id as string;
}

async function claim(ctx: Awaited<ReturnType<typeof setup>>) {
  const result = await ctx.request("POST", "/api/worker/claim", {}, { authorization: `Bearer ${ctx.cfg.workerToken}` });
  assert.equal(result.status, 200);
  assert.equal(result.value.protocol, "orloom.worker-lease.v1");
  const lease = result.value;
  const policyResult = await ctx.request("GET", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/recovery-policy`, undefined, leaseHeaders(lease));
  assert.equal(policyResult.status, 200);
  assert.deepEqual(Object.keys(policyResult.value.strategies).sort(), ["strategy:baseline", "strategy:recovery"]);
  return { lease, policy: policyResult.value };
}

function leaseHeaders(lease: any) {
  return { authorization: `Bearer ${lease.capabilityToken}`, "x-orloom-lease-token": lease.leaseToken, "x-orloom-lease-epoch": String(lease.leaseEpoch) };
}

function committedEpisodeAdapter(unknownOnPassSlice?: string): RecoveryJudgmentAdapter {
  return async (snapshot: DecisionSnapshotV1) => {
    const invalidPass = snapshot.status === "passed" && snapshot.sliceId === unknownOnPassSlice;
    const change = snapshot.status === "failed" || invalidPass;
    return {
      version: "orloom.judgment.v1", snapshotDigest: sha(canonicalJson(snapshot)), source: "jev",
      answer: change ? "change_strategy" : "continue",
      strategyId: change && !invalidPass ? "strategy:recovery" : null,
      checkId: change && !invalidPass ? "check:recovery" : null,
      policyVersion: "fixture-v1", policyDigest: snapshot.recoveryPolicyDigest,
      modelId, confidence: 1, usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
}

function fixtureWorkspace() { return { source: "const answer = 41;\n" }; }
function runFixedCheck(workspace: { source: string }) {
  const actual = runInNewContext(`${workspace.source}\nanswer;`) as number;
  const receipt = Buffer.from(JSON.stringify({ check: "answer-exactly-42", expected: 42, actual, exitCode: actual === 42 ? 0 : 1 }));
  return { exitCode: actual === 42 ? 0 : 1, receipt, actual };
}
function applyApprovedRecovery(workspace: { source: string }, strategyId: string) {
  assert.equal(strategyId, "strategy:recovery");
  assert.equal(workspace.source.match(/answer = 41;/g)?.length, 1, "approved repair applies only to the expected fixture state");
  workspace.source = workspace.source.replace("answer = 41;", "answer = 42;");
}

function progress(lease: any, policy: any, eventId: string, ordinal: number, strategyId: string, check: ReturnType<typeof runFixedCheck>, target = targetCheckId) {
  const passed = check.exitCode === 0;
  return {
    version: "orloom.progress.v1", eventId, missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, ordinal,
    planDigest: policy.planDigest, trustedCheckPolicyDigest: policy.trustedCheckPolicyDigest, recoveryPolicyDigest: policy.recoveryPolicyDigest,
    phase: "trusted_check", status: passed ? "passed" : "failed", reasonCode: passed ? "check_passed" : "check_failed",
    strategyId, targetCheckId: target, checkId: policy.strategies[strategyId].checkId,
    counters: { providerCalls: 0, inputTokens: 0, outputTokens: 0, wallMs: 1 }, evidenceRefs: [digestRef(check.receipt)],
  };
}

async function report(ctx: Awaited<ReturnType<typeof setup>>, lease: any, value: ReturnType<typeof progress>) {
  return ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, value, leaseHeaders(lease));
}

async function runEpisode(ctx: Awaited<ReturnType<typeof setup>>, lease: any, policy: any, prefix: string, gate?: boolean) {
  const workspace = fixtureWorkspace();
  const failedCheck = runFixedCheck(workspace);
  assert.equal(failedCheck.exitCode, 1, "the fixed check must fail on the initial fixture");
  const baseline = progress(lease, policy, `${prefix}-baseline-${randomUUID()}`, 1, "strategy:baseline", failedCheck);
  const wrongCapability = leaseHeaders(lease);
  wrongCapability.authorization = "Bearer wrong-capability";
  assert.equal((await ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, baseline, wrongCapability)).status, 409, "a duplicate event with the wrong capability is not authorized");
  let failed: Awaited<ReturnType<typeof report>>;
  if (gate) {
    const pending = report(ctx, lease, baseline);
    await ctx.transport.started;
    const dbWorkWhileJevWaits = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM mission_recovery_progress WHERE event_id=$1", [baseline.eventId]);
    assert.equal(Number(dbWorkWhileJevWaits.rows[0]?.n), 1, "prepared decision is durable while the adapter waits");
    assert.equal((await report(ctx, lease, baseline)).status, 409, "an unresolved same-event retry is not replayed as success");
    const gap = { ...baseline, eventId: `${prefix}-ordinal-gap`, ordinal: 3 };
    assert.equal((await report(ctx, lease, gap)).status, 409, "ordinal gaps are rejected while a judgment is in flight");
    ctx.transport.releaseChoice();
    failed = await pending;
  } else failed = await report(ctx, lease, baseline);
  assert.equal(failed.status, 200);
  assert.equal(failed.value.action.action, "change_strategy");
  assert.equal(failed.value.action.strategyId, "strategy:recovery");
  assert.equal(failed.value.judgment.source, "jev");
  assert.equal(failed.value.judgment.snapshotDigest, sha(canonicalJson(failed.value.snapshot)), "judgment binds the canonical immutable snapshot");
  assert.equal(failed.value.snapshot.missionBudgetCents, 90_000);
  assert.equal(failed.value.snapshot.sliceBudgetCents, 10_000);
  const missionAtDecision = await ctx.store.getMission(lease.mission.id);
  assert.equal(failed.value.snapshot.reservedBudgetCents, missionAtDecision?.mission.reservedCents, "the snapshot binds current mission-wide reservations");
  assert.equal(failed.value.snapshot.missionBudgetCents - failed.value.snapshot.reservedBudgetCents, 90_000 - (missionAtDecision?.mission.reservedCents ?? 0));
  assert.deepEqual(failed.value.snapshot.reportedUsage, baseline.counters);
  assert.deepEqual(failed.value.snapshot.evidenceRefs, baseline.evidenceRefs);
  const wrongCapabilityAfterCommit = leaseHeaders(lease);
  wrongCapabilityAfterCommit.authorization = "Bearer wrong-capability";
  assert.equal((await ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, baseline, wrongCapabilityAfterCommit)).status, 409, "committed replay still requires the lease capability");
  assert.equal((await report(ctx, lease, baseline)).status, 200);
  assert.equal((await report(ctx, lease, baseline)).value.duplicate, true);
  const reorderedBaseline = {
    evidenceRefs: [...baseline.evidenceRefs], counters: { wallMs: baseline.counters.wallMs, outputTokens: baseline.counters.outputTokens, inputTokens: baseline.counters.inputTokens, providerCalls: baseline.counters.providerCalls },
    checkId: baseline.checkId, targetCheckId: baseline.targetCheckId, strategyId: baseline.strategyId, reasonCode: baseline.reasonCode, status: baseline.status,
    phase: baseline.phase, recoveryPolicyDigest: baseline.recoveryPolicyDigest, trustedCheckPolicyDigest: baseline.trustedCheckPolicyDigest,
    planDigest: baseline.planDigest, ordinal: baseline.ordinal, leaseEpoch: baseline.leaseEpoch, sliceId: baseline.sliceId, missionId: baseline.missionId,
    eventId: baseline.eventId, version: baseline.version,
  };
  const reorderedReplay = await report(ctx, lease, reorderedBaseline);
  assert.equal(reorderedReplay.status, 200, "canonical replay accepts equivalent key order at every JSON depth");
  assert.equal(reorderedReplay.value.duplicate, true);
  assert.equal(reorderedReplay.value.action.eventId, baseline.eventId);
  assert.equal((await report(ctx, lease, { ...baseline, status: "passed", reasonCode: "check_passed" })).status, 409, "event ID reuse with changed content is rejected");

  applyApprovedRecovery(workspace, failed.value.action.strategyId);
  const passedCheck = runFixedCheck(workspace);
  assert.equal(passedCheck.exitCode, 0, "the same fixed check must pass after the approved state repair");
  const globallyTrustedButNotSelected = progress(lease, policy, `${prefix}-wrong-next-strategy-${randomUUID()}`, 2, "strategy:baseline", passedCheck);
  assert.equal((await report(ctx, lease, globallyTrustedButNotSelected)).status, 409, "globally approved checks still cannot bypass the previous Governor next-strategy action");
  const recovery = progress(lease, policy, `${prefix}-recovery-${randomUUID()}`, 2, "strategy:recovery", passedCheck);
  assert.equal((await report(ctx, lease, recovery)).status, 200);
  const repeatedAfterPass = progress(lease, policy, `${prefix}-repeated-after-pass-${randomUUID()}`, 3, "strategy:recovery", passedCheck);
  assert.equal((await report(ctx, lease, repeatedAfterPass)).status, 409, "a passed check is terminal for that recovery episode");
  return { baselineEventId: baseline.eventId, baselineEvidenceRef: baseline.evidenceRefs[0], recoveryEventId: recovery.eventId, recoveryEvidenceRef: recovery.evidenceRefs[0] };
}

test("authenticated HTTP and PGlite retain executable recovery evidence and an unpromoted candidate", async () => {
  const ctx = await setup({ holdFirstRecoveryChoice: true });
  try {
    assert.equal((await ctx.request("POST", "/api/missions", {})).status, 401);
    const missionId = await createMission(ctx, "fixture/recovery-proof", ["episode-a", "episode-b"]);
    const grants = await Promise.all([claim(ctx), claim(ctx)]);
    assert.equal(new Set(grants.map(x => x.lease.slice.id)).size, 2);
    const episodeA = await runEpisode(ctx, grants[0]!.lease, grants[0]!.policy, "episode-a", true);
    const episodeB = await runEpisode(ctx, grants[1]!.lease, grants[1]!.policy, "episode-b");
    assert.notEqual(episodeA.baselineEventId, episodeB.baselineEventId);

    const listed = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(listed.status, 200);
    const candidate = listed.value.find((row: any) => row.status === "candidate");
    assert(candidate, "two independently recovered slices form a candidate lesson");
    assert.equal(candidate.repository, "fixture/recovery-proof");
    assert.equal(candidate.cohort, "src");
    assert.equal(candidate.fromCheckId, targetCheckId);
    assert.equal(candidate.strategyId, "strategy:recovery");
    assert.equal(candidate.evidenceEventIds.length, 4);
    const provenance = {
      repository: candidate.repository, cohort: candidate.cohort, fromCheckId: candidate.fromCheckId, strategyId: candidate.strategyId,
      policyVersion: candidate.policyVersion, policyDigest: candidate.policyDigest, evidenceEventIds: [...candidate.evidenceEventIds].sort(),
      metric: candidate.metric, direction: candidate.direction, baseline: candidate.baseline, outcome: candidate.outcome,
    };
    assert.equal(candidate.challengeDigest, sha(canonicalJson(provenance)), "test independently recomputes the canonical challenge digest");
    assert.equal(candidate.lessonVersion, 1);
    assert.equal(candidate.baseline.failed, 2);
    assert.equal(candidate.outcome.passed, 2);
    assert.equal(candidate.metric, "trusted_check_pass_rate");
    assert.equal(candidate.direction, "increase");
    assert.match(candidate.challengeDigest, /^[a-f0-9]{64}$/);
    const receiptIds = [episodeA.baselineEventId, episodeA.recoveryEventId, episodeB.baselineEventId, episodeB.recoveryEventId];
    assert.deepEqual([...(candidate.evidenceEventIds as string[])].sort(), [...receiptIds].sort(), "candidate provenance must bind the four retained progress receipts");
    const durable = await ctx.db.query<{ event_id: string; progress: unknown }>("SELECT event_id,progress FROM mission_recovery_progress WHERE event_id=ANY($1::text[]) ORDER BY event_id", [receiptIds]);
    assert.equal(durable.rows.length, 4);
    const expectedEvidence = new Map([[episodeA.baselineEventId, episodeA.baselineEvidenceRef], [episodeA.recoveryEventId, episodeA.recoveryEvidenceRef], [episodeB.baselineEventId, episodeB.baselineEvidenceRef], [episodeB.recoveryEventId, episodeB.recoveryEvidenceRef]]);
    for (const row of durable.rows) {
      const event = row.progress as { status: string; strategyId: string; evidenceRefs: string[] };
      assert.equal(event.evidenceRefs[0], expectedEvidence.get(String(row.event_id)));
      assert.ok((event.status === "failed" && event.strategyId === "strategy:baseline") || (event.status === "passed" && event.strategyId === "strategy:recovery"));
    }
    const challenge = {
      version: "orloom.lesson-challenge.v1", lessonId: candidate.id, repository: candidate.repository, cohort: candidate.cohort,
      fromCheckId: candidate.fromCheckId, strategyId: candidate.strategyId, policyVersion: candidate.policyVersion, policyDigest: candidate.policyDigest,
      evidenceEventIds: [...candidate.evidenceEventIds].sort(), metric: candidate.metric, direction: candidate.direction,
      baseline: candidate.baseline, outcome: candidate.outcome,
    };
    const ownerPromotion = await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, challenge, { cookie: ctx.cookie });
    assert.equal(ownerPromotion.status, 503);
    assert.deepEqual(ownerPromotion.value, { error: "Independent lesson verification is unavailable; candidate remains unpromoted" });
    const beforeReconnect = await ctx.request("GET", `/api/missions/${missionId}/events?after=0`, undefined, { cookie: ctx.cookie });
    const candidateEvent = beforeReconnect.value.find((event: any) => event.type === "lesson.candidate" && event.data.lessonId === candidate.id);
    assert(candidateEvent, "candidate creation is in the durable mission event stream");
    await ctx.reconnect();
    const replay = await ctx.request("GET", `/api/missions/${missionId}/events?after=${candidateEvent.cursor - 1}`, undefined, { cookie: ctx.cookie });
    assert(replay.value.some((event: any) => event.cursor === candidateEvent.cursor && event.type === "lesson.candidate"));
    const afterReconnect = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(afterReconnect.value.find((row: any) => row.id === candidate.id)?.status, "candidate");
    assert.equal(ctx.transport.calls(), 4, "the SDK-backed adapter used exactly one injected request for each fixture progress decision");
  } finally { await ctx.close(); }
});

test("episodes with different target checks cannot form one comparable lesson candidate", async () => {
  const otherTarget = "target:other-check";
  const ctx = await setup({ targetCheckIds: [targetCheckId, otherTarget] });
  try {
    const missionId = await createMission(ctx, "fixture/mixed-target-proof", ["target-a", "target-b"]);
    for (const [index, id] of ["target-a", "target-b"].entries()) {
      const { lease, policy } = await claim(ctx);
      assert.equal(lease.mission.id, missionId);
      assert.equal(lease.slice.id, id);
      const workspace = fixtureWorkspace();
      const failure = runFixedCheck(workspace);
      assert.equal(failure.exitCode, 1);
      const failed = await report(ctx, lease, progress(lease, policy, `mixed-${index}-failed-${randomUUID()}`, 1, "strategy:baseline", failure, targetCheckId));
      assert.equal(failed.status, 200);
      assert.equal(failed.value.action.strategyId, "strategy:recovery");
      applyApprovedRecovery(workspace, failed.value.action.strategyId);
      const success = runFixedCheck(workspace);
      assert.equal(success.exitCode, 0);
      const passed = await report(ctx, lease, progress(lease, policy, `mixed-${index}-passed-${randomUUID()}`, 2, "strategy:recovery", success, otherTarget));
      assert.equal(passed.status, 200);
      assert.equal(passed.value.judgment.answer, "continue");
    }
    const lessons = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(lessons.status, 200);
    assert.equal(lessons.value.some((lesson: any) => lesson.status === "candidate"), false, "a failed check for target A and pass for target B are not comparable evidence");
  } finally { await ctx.close(); }
});

test("candidate extraction excludes UNKNOWN pass evidence in either episode order", async () => {
  for (const order of [["unknown-first", "valid-second"], ["valid-first", "unknown-second"]] as const) {
    const sliceIds = order.map((kind, index) => `episode-${index}-${kind}`);
    const unknownSlice = sliceIds[order.findIndex(value => value.startsWith("unknown"))]!;
    const ctx = await setup({ judgmentAdapter: committedEpisodeAdapter(unknownSlice), scopeClasses: ["src", "docs"] });
    try {
      const missionId = await createMission(ctx, `fixture/unresolved-pass-${unknownSlice}`, sliceIds, {
        [sliceIds[0]!]: ["src/unresolved/a"], [sliceIds[1]!]: ["src/unresolved/b"],
      });
      for (const [index, kind] of order.entries()) {
        const { lease, policy } = await claim(ctx);
        const sliceId = sliceIds[index]!;
        assert.equal(lease.mission.id, missionId);
        assert.equal(lease.slice.id, sliceId);
        const workspace = fixtureWorkspace();
        const failedCheck = runFixedCheck(workspace);
        const failed = await report(ctx, lease, progress(lease, policy, `${kind}-failed-${randomUUID()}`, 1, "strategy:baseline", failedCheck));
        assert.equal(failed.status, 200);
        assert.equal(failed.value.action.strategyId, "strategy:recovery");
        applyApprovedRecovery(workspace, failed.value.action.strategyId);
        const passedCheck = runFixedCheck(workspace);
        const passedEvent = progress(lease, policy, `${kind}-passed-${randomUUID()}`, 2, "strategy:recovery", passedCheck);
        const passResult = await report(ctx, lease, passedEvent);
        if (kind.startsWith("unknown")) {
          assert.equal(passResult.status, 409);
          const saved = await ctx.db.query<{ decision_status: string; action: unknown }>("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [passedEvent.eventId]);
          assert.equal(saved.rows[0]?.decision_status, "unknown");
          assert.equal(saved.rows[0]?.action, null);
        } else {
          assert.equal(passResult.status, 200);
          assert.equal(passResult.value.judgment.answer, "continue");
        }
      }
      const lessons = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
      assert.equal(lessons.status, 200);
      assert.equal(lessons.value.some((lesson: any) => lesson.status === "candidate"), false, `${unknownSlice} must not count as one of two committed success observations`);
    } finally { await ctx.close(); }
  }
});

test("mixed scope cohorts do not combine while unsorted same-cohort scopes form positive evidence", async () => {
  const mixed = await setup({ scopeClasses: ["src", "docs"] });
  try {
    const missionId = await createMission(mixed, "fixture/mixed-cohort-proof", ["source", "docs"], {
      source: ["src/recovery/source"], docs: ["docs/recovery/docs"],
    });
    for (const id of ["source", "docs"]) {
      const { lease, policy } = await claim(mixed);
      assert.equal(lease.mission.id, missionId);
      await runEpisode(mixed, lease, policy, `mixed-${id}-${randomUUID()}`);
    }
    const lessons = await mixed.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: mixed.cookie });
    assert.equal(lessons.status, 200);
    assert.equal(lessons.value.some((lesson: any) => lesson.status === "candidate"), false, "src and docs are distinct comparable cohorts");
  } finally { await mixed.close(); }

  const unsorted = await setup({ scopeClasses: ["src", "docs"] });
  try {
    const missionId = await createMission(unsorted, "fixture/unsorted-cohort-proof", ["unsorted-a", "unsorted-b"], {
      "unsorted-a": ["src/z", "docs/a"], "unsorted-b": ["docs/b", "src/y"],
    });
    for (const id of ["unsorted-a", "unsorted-b"]) {
      const { lease, policy } = await claim(unsorted);
      assert.equal(lease.mission.id, missionId);
      await runEpisode(unsorted, lease, policy, `unsorted-${id}-${randomUUID()}`);
    }
    const lessons = await unsorted.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: unsorted.cookie });
    assert.equal(lessons.status, 200);
    const candidate = lessons.value.find((lesson: any) => lesson.status === "candidate");
    assert(candidate, "two committed episodes with the same derived cohort form positive evidence");
    assert.equal(candidate.cohort, "docs", "cohort is based on the lexical minimum scope, not the supplied first scope");
    assert.equal(candidate.evidenceEventIds.length, 4);
  } finally { await unsorted.close(); }
});

test("an in-flight adapter result is fenced after lease expiry and the unresolved slice remains quarantined", async () => {
  const ctx = await setup({ holdFirstRecoveryChoice: true });
  try {
    const missionId = await createMission(ctx, "fixture/fence-proof", ["fenced"]);
    const { lease, policy } = await claim(ctx);
    const workspace = fixtureWorkspace();
    const check = runFixedCheck(workspace);
    assert.equal(check.exitCode, 1);
    const event = progress(lease, policy, `fenced-${randomUUID()}`, 1, "strategy:baseline", check);
    const inFlight = report(ctx, lease, event);
    await ctx.transport.started;
    await ctx.db.query("UPDATE mission_slices SET lease_expires_at=now()-interval '1 second' WHERE mission_id=$1 AND id=$2 AND lease_epoch=$3", [missionId, lease.slice.id, lease.leaseEpoch]);
    assert.equal(await ctx.store.expire(new Date(Date.now() + 1000)), 1);
    ctx.transport.releaseChoice();
    assert.equal((await inFlight).status, 409, "late adapter result cannot commit after lease expiry");
    const persisted = await ctx.db.query<{ decision_status: string }>("SELECT decision_status FROM mission_recovery_progress WHERE event_id=$1", [event.eventId]);
    assert.equal(persisted.rows[0]?.decision_status, "unknown");
    const slice = (await ctx.store.getMission(missionId))?.slices.find(item => item.id === lease.slice.id);
    assert.equal(slice?.status, "unknown");
    assert.equal(slice?.budgetCents, 10_000, "expiry keeps reserved budget attached to the quarantined slice");
    assert.equal((await ctx.store.getMission(missionId))?.mission.reservedCents, 10_000);
    assert.equal((await report(ctx, lease, { ...event, eventId: `stale-${randomUUID()}` })).status, 409);
    assert.equal(await ctx.store.claim(300, ctx.cfg.trustedCheckPolicyDigest!, undefined, ctx.cfg.recoveryPolicyDigest!), null, "unknown lease capacity stays quarantined");

    ctx.transport.setTerminal(true);
    const terminalMission = await createMission(ctx, "fixture/terminal-proof", ["terminal"]);
    const terminal = await claim(ctx);
    assert.equal(terminal.lease.mission.id, terminalMission);
    const terminalCheck = runFixedCheck(fixtureWorkspace());
    assert.equal(terminalCheck.exitCode, 1);
    const terminalProgress = progress(terminal.lease, terminal.policy, `terminal-${randomUUID()}`, 1, "strategy:baseline", terminalCheck);
    const decision = await report(ctx, terminal.lease, terminalProgress);
    assert.equal(decision.status, 200);
    assert.equal(decision.value.action.action, "escalate");
    const terminalState = await ctx.store.getMission(terminalMission);
    assert.equal(terminalState?.slices.find(item => item.id === "terminal")?.status, "unknown");
    assert.equal(terminalState?.mission.reservedCents, 10_000, "terminal uncertainty keeps its budget reserved");
    assert.equal((await report(ctx, terminal.lease, { ...terminalProgress, eventId: `terminal-stale-${randomUUID()}` })).status, 409);
    assert.equal(await ctx.store.claim(300, ctx.cfg.trustedCheckPolicyDigest!, undefined, ctx.cfg.recoveryPolicyDigest!), null, "terminal UNKNOWN remains quarantined");
  } finally { await ctx.close(); }
});

test("an in-flight decision is quarantined if authoritative mission budget changes after snapshot", async () => {
  const ctx = await setup({ holdFirstRecoveryChoice: true });
  try {
    const missionId = await createMission(ctx, "fixture/snapshot-budget-fence", ["budget-fenced"]);
    const { lease, policy } = await claim(ctx);
    const failed = runFixedCheck(fixtureWorkspace());
    const event = progress(lease, policy, `budget-fence-${randomUUID()}`, 1, "strategy:baseline", failed);
    const inFlight = report(ctx, lease, event);
    await ctx.transport.started;
    const changed = await ctx.db.query("UPDATE missions SET budget_cents=budget_cents+1 WHERE id=$1", [missionId]);
    assert.equal(changed.rowCount, 1, "the isolated fixture changed authoritative budget while the adapter was pending");
    ctx.transport.releaseChoice();
    assert.equal((await inFlight).status, 409, "a stale snapshot cannot commit after budget context changes");
    const row = await ctx.db.query<{ decision_status: string; action: unknown }>("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [event.eventId]);
    assert.equal(row.rows[0]?.decision_status, "unknown");
    assert.equal(row.rows[0]?.action, null);
    const current = await ctx.store.getMission(missionId);
    assert.equal(current?.mission.budgetCents, 90_001);
    assert.equal(current?.mission.reservedCents, 10_000);
    assert.equal(current?.slices.find(item => item.id === "budget-fenced")?.status, "unknown");
    assert.equal(await ctx.store.claim(300, ctx.cfg.trustedCheckPolicyDigest!, undefined, ctx.cfg.recoveryPolicyDigest!), null, "budget-fenced UNKNOWN remains quarantined");
  } finally { await ctx.close(); }
});

test("an impossible model continue on a failed check commits no decision and quarantines the slice", async () => {
  const invalidContinue: RecoveryJudgmentAdapter = async (snapshot: DecisionSnapshotV1) => ({
    version: "orloom.judgment.v1", snapshotDigest: sha(canonicalJson(snapshot)), source: "jev", answer: "continue",
    strategyId: null, checkId: null, policyVersion: "fixture-v1", policyDigest: snapshot.recoveryPolicyDigest,
    modelId, confidence: 1, usage: { inputTokens: 1, outputTokens: 1 },
  });
  const ctx = await setup({ judgmentAdapter: invalidContinue });
  try {
    const missionId = await createMission(ctx, "fixture/invalid-judgment", ["invalid"]);
    const { lease, policy } = await claim(ctx);
    const failed = runFixedCheck(fixtureWorkspace());
    assert.equal(failed.exitCode, 1);
    const event = progress(lease, policy, `invalid-continue-${randomUUID()}`, 1, "strategy:baseline", failed);
    assert.equal((await report(ctx, lease, event)).status, 409);
    const row = await ctx.db.query<{ decision_status: string; action: unknown }>("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [event.eventId]);
    assert.equal(row.rows[0]?.decision_status, "unknown");
    assert.equal(row.rows[0]?.action, null);
    const current = await ctx.store.getMission(missionId);
    assert.equal(current?.slices.find(item => item.id === "invalid")?.status, "unknown");
    assert.equal(current?.mission.reservedCents, 10_000);
    assert.equal(await ctx.store.claim(300, ctx.cfg.trustedCheckPolicyDigest!, undefined, ctx.cfg.recoveryPolicyDigest!), null);
  } finally { await ctx.close(); }
});

test("blocked and unknown progress cannot be continued by an injected judgment", async () => {
  const invalidContinue: RecoveryJudgmentAdapter = async (snapshot: DecisionSnapshotV1) => ({
    version: "orloom.judgment.v1", snapshotDigest: sha(canonicalJson(snapshot)), source: "jev", answer: "continue",
    strategyId: null, checkId: null, policyVersion: "fixture-v1", policyDigest: snapshot.recoveryPolicyDigest,
    modelId, confidence: 1, usage: { inputTokens: 1, outputTokens: 1 },
  });
  const ctx = await setup({ judgmentAdapter: invalidContinue });
  try {
    for (const status of ["blocked", "unknown"] as const) {
      const missionId = await createMission(ctx, `fixture/${status}-continue`, [status]);
      const { lease, policy } = await claim(ctx);
      assert.equal(lease.mission.id, missionId);
      const check = runFixedCheck(fixtureWorkspace());
      const event = { ...progress(lease, policy, `${status}-continue-${randomUUID()}`, 1, "strategy:baseline", check), status, reasonCode: "provider_unavailable" as const };
      assert.equal((await report(ctx, lease, event)).status, 409);
      const stored = await ctx.db.query<{ decision_status: string; action: unknown }>("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [event.eventId]);
      assert.equal(stored.rows[0]?.decision_status, "unknown");
      assert.equal(stored.rows[0]?.action, null);
      const current = await ctx.store.getMission(missionId);
      assert.equal(current?.slices.find(item => item.id === status)?.status, "unknown");
      assert.equal(current?.mission.reservedCents, 10_000);
    }
    assert.equal(await ctx.store.claim(300, ctx.cfg.trustedCheckPolicyDigest!, undefined, ctx.cfg.recoveryPolicyDigest!), null, "both ambiguous outcomes stay quarantined");
  } finally { await ctx.close(); }
});
