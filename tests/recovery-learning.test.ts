import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { TrustedCheckCoordinator, type RecoveryJudgmentAdapter } from "../packages/governor/src/governor.js";
import { receiptDigestV1, trustedCheckRequestDigestV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import type { DecisionSnapshotV1 } from "../packages/judgment/src/types.js";
import { loadConfig } from "../packages/config/src/config.js";
import { DurableArtifactStore } from "../packages/verification/src/artifact-store.js";
import { canonicalJson as canonicalReceiptJson } from "../packages/judgment/src/canonical.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digestRef = (receipt: Uint8Array) => `sha256:${sha(receipt)}`;
const targetCheckId = "target:answer-42";
const modelId = "fixture-jevt-model-v1";
const strategies = {
  "strategy:baseline": { checkId: "check:baseline", version: "fixture-v1", expectedSignal: "the fixture returns 42", scopeClasses: ["src"], targetCheckIds: [targetCheckId] },
  "strategy:recovery": { checkId: "check:recovery", version: "fixture-v1", expectedSignal: "the same fixture check returns 42 after the approved repair", scopeClasses: ["src"], targetCheckIds: [targetCheckId] },
};

function config(targetCheckIds: string[] = [targetCheckId], scopeClasses: string[] = ["src"], sharedCheckId = false, competingAlternative = false) {
  const trustedStrategies = {
    ...strategies,
    ...(competingAlternative ? { "strategy:other": { ...strategies["strategy:recovery"], targetCheckIds, scopeClasses } } : {}),
    "strategy:baseline": { ...strategies["strategy:baseline"], targetCheckIds, scopeClasses },
    "strategy:recovery": { ...strategies["strategy:recovery"], checkId: sharedCheckId ? "check:baseline" : strategies["strategy:recovery"].checkId, targetCheckIds, scopeClasses },
  };
  return loadConfig({
    ORLOOM_MODE: "local", PORT: "3000", ORLOOM_SESSION_TOKEN: "owner-fixture-session", ORLOOM_WORKER_TOKEN: "worker-fixture-bootstrap",
    ORLOOM_MAX_LANES: "6", ORLOOM_CAPACITY_SLOTS: "6", ORLOOM_CAPACITY_EVIDENCE_VERIFIED: "true",
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

async function setup(options: { holdFirstRecoveryChoice?: boolean; judgmentAdapter?: RecoveryJudgmentAdapter; targetCheckIds?: string[]; scopeClasses?: string[]; sharedCheckId?: boolean; competingAlternative?: boolean } = {}) {
  const db = new PGlite();
  const artifactTempRoot = await mkdtemp(join(tmpdir(), "orloom-c1b-artifacts-"));
  assert(artifactTempRoot.startsWith(join(tmpdir(), "orloom-c1b-artifacts-")));
  const artifactStore = new DurableArtifactStore(join(artifactTempRoot, "objects"));
  const receiptBlobs = new Map<string, Buffer>();
  await db.exec(await readFile("db/migrations/001_initial.sql", "utf8"));
  await db.exec(await readFile("db/migrations/002_missions.sql", "utf8"));
  await db.exec(await readFile("db/migrations/003_recovery.sql", "utf8"));
  await db.exec(await readFile("db/migrations/004_verification.sql", "utf8"));
  await db.exec(await readFile("db/migrations/005_learning.sql", "utf8"));
  let transactionGate = Promise.resolve();
  let lastTransactionError = "";
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
        lastTransactionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        await db.exec("ROLLBACK");
        throw error;
      } finally { release(); }
    },
  };
  let store = new SqlMissionStore(sql);
  const cfg = config(options.targetCheckIds, options.scopeClasses, options.sharedCheckId, options.competingAlternative);
  await store.configureCapacity(6, cfg.capacityEvidenceDigest!, cfg.capacityEvidenceExpiresAt!);
  const transport = jevTransport(options);
  const jev = new JevClient({ apiKey: "fixture-only-key", modelId, allowedModelIds: new Set([modelId]), limits: { maxInputBytes: 64_000, maxResponseBytes: 32_000, timeoutMs: 2_000 }, fetch: transport.fetch });
  const jobs = new MemoryJobStore();
  const judgmentAdapter = options.judgmentAdapter ?? createJevRecoveryAdapter(jev);
  let nextOutcome: "pass" | "fail" | "unknown" = "fail";
  const runner = {
    prepareBundle: async (_repository: string, _baseSha: string, candidateSha: string) => {
      const manifest = Buffer.from(JSON.stringify({ candidateSha }));
      return { digest: sha(manifest), manifest, files: new Map([["manifest.json", manifest]]) };
    },
    observeHead: async (_repository: string) => ({ sha: currentHead, observedAt: new Date().toISOString(), digest: sha(currentHead) }),
    run: async (request: TrustedCheckRequestV1) => {
      const stdout = Buffer.from(nextOutcome === "pass" ? "check passed\n" : nextOutcome === "fail" ? "check failed\n" : "check outcome unknown\n");
      const stderr = Buffer.alloc(0);
      const manifest = Buffer.from(JSON.stringify({ candidateSha: request.candidateSha, checkId: request.checkId }));
      const body = { version: "orloom.trusted-check-receipt.v1" as const, request, verifierId: "fixture-verifier-v1", runtime: "runsc" as const, sandboxId: randomUUID(), outcome: nextOutcome, exitCode: nextOutcome === "pass" ? 0 : nextOutcome === "fail" ? 1 : null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stdout: await artifactStore.put(stdout), stderr: await artifactStore.put(stderr), inputManifest: await artifactStore.put(manifest) };
      const receipt = { ...body, receiptDigest: receiptDigestV1(body) };
      receiptBlobs.set(request.attemptId, Buffer.from(canonicalReceiptJson(receipt)));
      return receipt;
    },
    verifyArtifacts: async (receipt: TrustedCheckReceiptV1) => {
      const storedReceipt = receiptBlobs.get(receipt.request.attemptId);
      if (!storedReceipt?.equals(Buffer.from(canonicalReceiptJson(receipt)))) throw new Error("canonical receipt blob is absent or altered");
      return { stdout: await artifactStore.verify(receipt.stdout), stderr: await artifactStore.verify(receipt.stderr), manifest: await artifactStore.verify(receipt.inputManifest) };
    },
  };
  let currentHead = "";
  const coordinator = new TrustedCheckCoordinator(store, runner, { imageDigest: sha("fixture-image"), verifierId: "fixture-verifier-v1", policyDigest: cfg.trustedCheckPolicyDigest!, leasePolicyDigest: cfg.trustedCheckPolicyDigest!, policyVersion: "fixture-v1", allowedChecks: cfg.trustedCheckPolicy ?? [], attemptLifetimeMs: 60_000 });
  const fixtureActivation = { assertAccepted: async () => {} }; // Controlled fixture only; not runtime acceptance.
  let server = createControlPlane(cfg, jobs, store, judgmentAdapter, coordinator, fixtureActivation);
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
    coordinator, setTrustedOutcome: (outcome: "pass" | "fail" | "unknown", shaValue: string) => { nextOutcome = outcome; currentHead = shaValue; },
    get lastTransactionError() { return lastTransactionError; },
    alterArtifact: (hash: string) => writeFile(join(artifactStore.root, hash), "altered durable artifact bytes\n"),
    restoreArtifact: (hash: string, bytes: Buffer) => writeFile(join(artifactStore.root, hash), bytes),
    removeArtifact: (hash: string) => unlink(join(artifactStore.root, hash)),
    alterReceiptBlob: (attemptId: string) => { receiptBlobs.set(attemptId, Buffer.from("altered canonical receipt blob\n")); },
    restoreReceiptBlob: (attemptId: string, receipt: TrustedCheckReceiptV1) => { receiptBlobs.set(attemptId, Buffer.from(canonicalReceiptJson(receipt))); },
    reconnect: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store = new SqlMissionStore(sql);
      server = createControlPlane(cfg, jobs, store, judgmentAdapter, new TrustedCheckCoordinator(store, runner, { imageDigest: sha("fixture-image"), verifierId: "fixture-verifier-v1", policyDigest: cfg.trustedCheckPolicyDigest!, leasePolicyDigest: cfg.trustedCheckPolicyDigest!, policyVersion: "fixture-v1", allowedChecks: cfg.trustedCheckPolicy ?? [], attemptLifetimeMs: 60_000 }), fixtureActivation);
      await listen();
      const login = await request("POST", "/session", { token: cfg.sessionToken }); assert.equal(login.status, 204);
    },
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await db.close(); await rm(artifactTempRoot, { recursive: true, force: true }); },
  };
}

async function createMission(ctx: Awaited<ReturnType<typeof setup>>, repository: string, sliceIds: string[], scopeBySlice: Record<string, string[]> = {}, checks = ["strategy:baseline", "strategy:recovery"]) {
  const { status, value } = await ctx.request("POST", "/api/missions", {
    repository, baseSha: sha(`${repository}-base`).slice(0, 40), objective: "Exercise a real fixed recovery check and durable lesson policy.", acceptance: ["The same fixed check succeeds after an approved repair."], budgetCents: 90_000,
  }, { cookie: ctx.cookie });
  assert.equal(status, 201);
  const slices = sliceIds.map(id => ({ id, objective: `Run fixed check for ${id}`, dependencies: [], owner: "fixture-owner", scopes: scopeBySlice[id] ?? [`src/recovery/${id}`], checks, budgetCents: 10_000 }));
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
  assert.deepEqual(Object.keys(policyResult.value.strategies).sort(), Object.keys(ctx.cfg.trustedStrategies!).filter(id => lease.slice.checks.includes(id)).sort());
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

async function trustedProgress(ctx: Awaited<ReturnType<typeof setup>>, lease: any, policy: any, eventId: string, ordinal: number, strategyId: string, outcome: "pass" | "fail" | "unknown", target = targetCheckId) {
  const candidateSha = sha(`${eventId}:${randomUUID()}`).slice(0, 40);
  ctx.setTrustedOutcome(outcome, candidateSha);
  const trusted = await ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/recovery-check`, {
    candidateSha, targetCheckId: target, strategyId, ordinal,
  }, leaseHeaders(lease));
  assert.equal(trusted.status, 200, `${JSON.stringify(trusted.value)} sql=${ctx.lastTransactionError} attempts=${JSON.stringify((await ctx.db.query("SELECT check_id,strategy_id,recovery_ordinal,outcome FROM verification_attempts WHERE mission_id=$1 AND slice_id=$2 ORDER BY recovery_ordinal", [lease.mission.id, lease.slice.id])).rows)}`);
  assert.equal(trusted.value.outcome, outcome);
  return {
    version: "orloom.progress.v2", eventId, missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, ordinal,
    planDigest: policy.planDigest, trustedCheckPolicyDigest: policy.trustedCheckPolicyDigest, recoveryPolicyDigest: policy.recoveryPolicyDigest,
    phase: "trusted_check", status: outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "unknown", reasonCode: outcome === "pass" ? "check_passed" : outcome === "fail" ? "check_failed" : "provider_unavailable",
    strategyId, targetCheckId: target, checkId: policy.strategies[strategyId].checkId,
    counters: { providerCalls: 0, inputTokens: 0, outputTokens: 0, wallMs: 1 }, evidenceRefs: [`sha256:${trusted.value.receiptDigest}`],
    trustedAttemptId: trusted.value.attemptId, candidateSha,
  };
}

async function report(ctx: Awaited<ReturnType<typeof setup>>, lease: any, value: ReturnType<typeof progress>) {
  return ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, value, leaseHeaders(lease));
}

async function runEpisode(ctx: Awaited<ReturnType<typeof setup>>, lease: any, policy: any, prefix: string, gate?: boolean) {
  const workspace = fixtureWorkspace();
  const failedCheck = runFixedCheck(workspace);
  assert.equal(failedCheck.exitCode, 1, "the fixed check must fail on the initial fixture");
  const baseline = await trustedProgress(ctx, lease, policy, `${prefix}-baseline-${randomUUID()}`, 1, "strategy:baseline", "fail");
  const wrongCapability = leaseHeaders(lease);
  wrongCapability.authorization = "Bearer wrong-capability";
  assert.notEqual((await ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, baseline, wrongCapability)).status, 200, "a duplicate event with the wrong capability is not authorized");
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
    eventId: baseline.eventId, version: baseline.version, trustedAttemptId: baseline.trustedAttemptId, candidateSha: baseline.candidateSha,
  };
  const reorderedReplay = await report(ctx, lease, reorderedBaseline);
  assert.equal(reorderedReplay.status, 200, "canonical replay accepts equivalent key order at every JSON depth");
  assert.equal(reorderedReplay.value.duplicate, true);
  assert.equal(reorderedReplay.value.action.eventId, baseline.eventId);
    assert.notEqual((await report(ctx, lease, { ...baseline, status: "passed", reasonCode: "check_passed" })).status, 200, "event ID reuse with changed content is rejected");

  applyApprovedRecovery(workspace, failed.value.action.strategyId);
  const passedCheck = runFixedCheck(workspace);
  assert.equal(passedCheck.exitCode, 0, "the same fixed check must pass after the approved state repair");
  const globallyTrustedButNotSelected = progress(lease, policy, `${prefix}-wrong-next-strategy-${randomUUID()}`, 2, "strategy:baseline", passedCheck);
  assert.notEqual((await report(ctx, lease, globallyTrustedButNotSelected)).status, 200, "globally approved checks still cannot bypass the previous Governor next-strategy action");
  const recovery = await trustedProgress(ctx, lease, policy, `${prefix}-recovery-${randomUUID()}`, 2, "strategy:recovery", "pass");
  assert.equal((await report(ctx, lease, recovery)).status, 200);
  const repeatedAfterPass = progress(lease, policy, `${prefix}-repeated-after-pass-${randomUUID()}`, 3, "strategy:recovery", passedCheck);
  assert.notEqual((await report(ctx, lease, repeatedAfterPass)).status, 200, "a passed check is terminal for that recovery episode");
  return { baselineEventId: baseline.eventId, baselineEvidenceRef: baseline.evidenceRefs[0], baselineAttemptId: baseline.trustedAttemptId, recoveryEventId: recovery.eventId, recoveryEvidenceRef: recovery.evidenceRefs[0], recoveryAttemptId: recovery.trustedAttemptId };
}

test("trusted recovery evidence is challenged, promoted, selected later, then withdrawn on contradiction", async () => {
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
    const challenge = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.value));
    assert.equal(challenge.value.decision, "accepted", challenge.value.reason);
    const challengeReplay = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
    assert.equal(challengeReplay.status, 200);
    assert.equal(challengeReplay.value.attestationDigest, challenge.value.attestationDigest, "challenge replay resolves to the same immutable attestation");
    const competingId = randomUUID(), competingVersion = candidate.lessonVersion + 1;
    await ctx.db.query("INSERT INTO operational_lessons(id,repository,cohort,from_check_id,strategy_id,rule,lesson_version,metric,direction,baseline_failed,baseline_observed,outcome_passed,outcome_observed,policy_version,policy_digest,status,evidence_event_ids,challenge_digest,proposed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'candidate',$16::jsonb,$17,$18)", [competingId,candidate.repository,candidate.cohort,candidate.fromCheckId,candidate.strategyId,"competing source fixture",competingVersion,candidate.metric,candidate.direction,candidate.baseline.failed,candidate.baseline.observed,candidate.outcome.passed,candidate.outcome.observed,candidate.policyVersion,candidate.policyDigest,JSON.stringify(candidate.evidenceEventIds),sha("competing-candidate"),"test-fixture"]);
    const competingChallenge = await ctx.store.recordLessonChallenge!({lessonId:competingId,lessonVersion:competingVersion,candidateDigest:sha("competing-candidate"),challengeDigest:challenge.value.challengeDigest,evidenceDigest:challenge.value.evidenceDigest,verifierId:challenge.value.verifierId,algorithmVersion:challenge.value.algorithmVersion,decision:"accepted",reason:"lock-level concurrency fixture"});
    const firstPromotion = ctx.store.promoteLesson(candidate.id, challenge.value.attestationDigest, "controller:test");
    const conflictingPromotion = ctx.store.promoteLesson(competingId, competingChallenge, "controller:test");
    const promotionRace = await Promise.allSettled([firstPromotion, conflictingPromotion]);
    assert.equal(promotionRace.filter(x => x.status === "fulfilled").length, 1, "serialized conflicting promotions allow exactly one active version");
    assert.equal(promotionRace.filter(x => x.status === "rejected").length, 1);
    const ownerPromotion = await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, { challengeDigest: challenge.value.attestationDigest }, { cookie: ctx.cookie });
    assert.equal(ownerPromotion.status, 200, JSON.stringify(ownerPromotion.value));
    const beforeReconnect = await ctx.request("GET", `/api/missions/${missionId}/events?after=0`, undefined, { cookie: ctx.cookie });
    const candidateEvent = beforeReconnect.value.find((event: any) => event.type === "lesson.candidate" && event.data.lessonId === candidate.id);
    assert(candidateEvent, "candidate creation is in the durable mission event stream");
    await ctx.reconnect();
    const replay = await ctx.request("GET", `/api/missions/${missionId}/events?after=${candidateEvent.cursor - 1}`, undefined, { cookie: ctx.cookie });
    assert(replay.value.some((event: any) => event.cursor === candidateEvent.cursor && event.type === "lesson.candidate"));
    const afterReconnect = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(afterReconnect.value.find((row: any) => row.id === candidate.id)?.status, "promoted");
    const laterMission = await createMission(ctx, "fixture/recovery-proof", ["later-use"]);
    const later = await claim(ctx);
    assert.equal(later.lease.mission.id, laterMission);
    const laterFailure = await trustedProgress(ctx, later.lease, later.policy, `later-fail-${randomUUID()}`, 1, "strategy:baseline", "fail");
    const selected = await report(ctx, later.lease, laterFailure);
    assert.equal(selected.status, 200);
    assert.equal(selected.value.snapshot.lessonBindings.length, 1, "a later comparable decision binds the promoted lesson and challenge digest");
    assert.equal(selected.value.snapshot.lessonBindings[0].id, candidate.id);
    assert.equal(selected.value.snapshot.lessonBindings[0].challengeDigest, challenge.value.attestationDigest);
    assert.equal(selected.value.action.strategyId, "strategy:recovery", "Jev sees the promoted strategy first among finite authorized alternatives");
    assert.deepEqual(selected.value.action.lessonBindings, selected.value.snapshot.lessonBindings);
    assert.equal((await ctx.request("GET", `/api/lessons/${candidate.id}/impact`)).status, 401);
    const pendingImpact = await ctx.request("GET", `/api/lessons/${candidate.id}/impact`, undefined, { cookie: ctx.cookie });
    assert.equal(pendingImpact.status, 200);
    assert.equal(pendingImpact.value.decisions.length, 1);
    assert.equal(pendingImpact.value.decisions[0].outcome, "pending");
    assert.equal(pendingImpact.value.measuredImprovement, null);
    const contradiction = await trustedProgress(ctx, later.lease, later.policy, `later-contradiction-${randomUUID()}`, 2, "strategy:recovery", "fail");
    assert.equal((await report(ctx, later.lease, contradiction)).status, 200);
    const failedImpact = await ctx.request("GET", `/api/lessons/${candidate.id}/impact`, undefined, { cookie: ctx.cookie });
    assert.equal(failedImpact.status, 200);
    assert.equal(failedImpact.value.decisions[0].outcome, "fail");
    assert.equal(failedImpact.value.decisions[0].attemptId, contradiction.trustedAttemptId);
    assert.equal(failedImpact.value.decisions[0].receiptDigest, contradiction.evidenceRefs[0]!.slice(7));
    assert.equal(failedImpact.value.measuredImprovement, null, "an applied preference and failure do not prove improvement");
    const withdrawn = await ctx.request("GET", `/api/missions/${laterMission}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(withdrawn.value.find((row: any) => row.id === candidate.id)?.status, "withdrawn", "one trusted contradiction withdraws the exact promoted version");
    const freshMission = await createMission(ctx, "fixture/recovery-proof", ["after-withdrawal"]);
    const fresh = await claim(ctx);
    assert.equal(fresh.lease.mission.id, freshMission);
    const freshFailure = await trustedProgress(ctx, fresh.lease, fresh.policy, `fresh-fail-${randomUUID()}`, 1, "strategy:baseline", "fail");
    const freshDecision = await report(ctx, fresh.lease, freshFailure);
    assert.equal(freshDecision.status, 200);
    assert.deepEqual(freshDecision.value.snapshot.lessonBindings, [], "withdrawn lessons are absent from fresh decisions");
    assert.equal(ctx.transport.calls(), 6, "each committed Governor judgment used exactly one injected SDK-backed adapter request");
  } finally { await ctx.close(); }
});

test("verified lesson changes a later comparable choice and retains pass and UNKNOWN outcomes across reconnect", async () => {
  const ctx = await setup({ competingAlternative: true });
  try {
    const repository = "fixture/measured-choice";
    const checks = ["strategy:baseline", "strategy:other", "strategy:recovery"];
    await createMission(ctx, repository, ["before"], {}, checks);
    const before = await claim(ctx);
    const baseline = await report(ctx, before.lease, await trustedProgress(ctx, before.lease, before.policy, `before-${randomUUID()}`, 1, "strategy:baseline", "fail"));
    assert.equal(baseline.value.action.strategyId, "strategy:other");
    assert.deepEqual(baseline.value.action.lessonBindings, []);
    const sourceMission = await createMission(ctx, repository, ["source-a", "source-b"]);
    for (const id of ["source-a", "source-b"]) { const grant = await claim(ctx); await runEpisode(ctx, grant.lease, grant.policy, id); }
    const candidate = (await ctx.store.lessons(sourceMission))[0]!;
    const challenge = await ctx.coordinator.challengeLesson(candidate.id);
    assert.equal(challenge.decision, "accepted");
    assert.equal((await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, { challengeDigest: challenge.attestationDigest }, { cookie: ctx.cookie })).status, 200);
    for (const outcome of ["pass", "unknown"] as const) {
      await createMission(ctx, repository, [`later-${outcome}`], {}, checks);
      const later = await claim(ctx);
      const choice = await report(ctx, later.lease, await trustedProgress(ctx, later.lease, later.policy, `${outcome}-baseline-${randomUUID()}`, 1, "strategy:baseline", "fail"));
      assert.equal(choice.value.snapshot.alternatives[0].id, "strategy:other", "approved alternatives are identical before and after promotion");
      assert.equal(choice.value.action.strategyId, "strategy:recovery", "verified preference changes the fixed-choice adapter's subsequent decision");
      assert.equal(choice.value.action.lessonBindings[0].id, candidate.id);
      const result = await trustedProgress(ctx, later.lease, later.policy, `${outcome}-outcome-${randomUUID()}`, 2, "strategy:recovery", outcome);
      if (outcome === "pass") assert.equal((await report(ctx, later.lease, result)).status, 200);
    }
    await ctx.reconnect();
    const audit = await ctx.request("GET", `/api/lessons/${candidate.id}/impact`, undefined, { cookie: ctx.cookie });
    assert.equal(audit.status, 200);
    assert.deepEqual(audit.value.counts, { applied: 2, pass: 1, fail: 0, unknown: 1, pending: 0 });
    assert(audit.value.decisions.every((d: any) => d.preferenceChangedOrder && d.attemptId && d.receiptDigest));
    assert.equal(audit.value.measuredImprovement, null, "choice change is demonstrated; fixtures and UNKNOWN do not establish a live performance gain");
  } finally { await ctx.close(); }
});

test("impact retains an authorized outcome if another lease withdraws the lesson before check creation", async () => {
  const ctx = await setup();
  try {
    const repository="fixture/withdraw-before-attempt";
    const missionId=await createMission(ctx,repository,["a","b"]);
    for(const id of ["a","b"]){const grant=await claim(ctx);await runEpisode(ctx,grant.lease,grant.policy,id);}
    const candidate=(await ctx.store.lessons(missionId))[0]!;
    const challenge=await ctx.coordinator.challengeLesson(candidate.id);
    assert.equal((await ctx.request("POST",`/api/lessons/${candidate.id}/promote`,{challengeDigest:challenge.attestationDigest},{cookie:ctx.cookie})).status,200);
    await createMission(ctx,repository,["later","withdrawer"]);
    const later=await claim(ctx),withdrawer=await claim(ctx);
    for(const grant of [later,withdrawer]){
      assert.equal((await report(ctx,grant.lease,await trustedProgress(ctx,grant.lease,grant.policy,`failure-${randomUUID()}`,1,"strategy:baseline","fail"))).status,200);
    }
    await trustedProgress(ctx,withdrawer.lease,withdrawer.policy,`contradiction-${randomUUID()}`,2,"strategy:recovery","fail");
    assert.equal((await ctx.store.getLesson!(candidate.id))?.status,"withdrawn");
    const receipt=await trustedProgress(ctx,later.lease,later.policy,`after-withdrawal-${randomUUID()}`,2,"strategy:recovery","unknown");
    const audit=await ctx.request("GET",`/api/lessons/${candidate.id}/impact`,undefined,{cookie:ctx.cookie});
    assert.equal(audit.status,200);
    const decision=audit.value.decisions.find((d:any)=>d.sliceId===later.lease.slice.id);
    assert.equal(decision.attemptId,receipt.trustedAttemptId);
    assert.equal(decision.outcome,"unknown");
    assert.equal(decision.lessonStillBoundAtAttempt,false);
    assert.equal(audit.value.counts.pending,0);
    assert.equal(audit.value.counts.fail,1);
    assert.equal(audit.value.counts.unknown,1);
  }finally{await ctx.close();}
});

test("independent challenger rejects a candidate cohort differing from its persisted observations", async () => {
  const ctx = await setup();
  try {
    const missionId = await createMission(ctx, "fixture/cohort-binding", ["a", "b"]);
    for (const id of ["a", "b"]) { const grant = await claim(ctx); await runEpisode(ctx, grant.lease, grant.policy, id); }
    const candidate = (await ctx.store.lessons(missionId))[0]!;
    await ctx.db.query("UPDATE operational_lessons SET cohort='docs' WHERE id=$1", [candidate.id]);
    const challenged = await ctx.coordinator.challengeLesson(candidate.id);
    assert.equal(challenged.decision, "rejected");
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
      const failed = await report(ctx, lease, await trustedProgress(ctx, lease, policy, `mixed-${index}-failed-${randomUUID()}`, 1, "strategy:baseline", "fail", targetCheckId));
      assert.equal(failed.status, 200);
      assert.equal(failed.value.action.strategyId, "strategy:recovery");
      applyApprovedRecovery(workspace, failed.value.action.strategyId);
      const success = runFixedCheck(workspace);
      assert.equal(success.exitCode, 0);
      const passed = await report(ctx, lease, await trustedProgress(ctx, lease, policy, `mixed-${index}-passed-${randomUUID()}`, 2, "strategy:recovery", "pass", otherTarget));
      assert.equal(passed.status, 200);
      assert.equal(passed.value.judgment.answer, "continue");
    }
    const lessons = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(lessons.status, 200);
    assert.equal(lessons.value.some((lesson: any) => lesson.status === "candidate"), false, "a failed check for target A and pass for target B are not comparable evidence");
  } finally { await ctx.close(); }
});

test("two strategies may share one trusted check ID while retaining distinct immutable strategy attribution", async () => {
  const ctx = await setup({ sharedCheckId: true });
  try {
    const missionId = await createMission(ctx, "fixture/shared-check-id", ["shared-a", "shared-b"]);
    for (const id of ["shared-a", "shared-b"]) {
      const { lease, policy } = await claim(ctx);
      assert.equal(lease.mission.id, missionId);
      const pair = await runEpisode(ctx, lease, policy, `shared-${id}-${randomUUID()}`);
      const attempts = await ctx.db.query<{ strategy_id: string; check_id: string }>("SELECT strategy_id,check_id FROM verification_attempts WHERE attempt_id=ANY($1::uuid[]) ORDER BY recovery_ordinal", [[pair.baselineAttemptId, pair.recoveryAttemptId]]);
      assert.deepEqual(attempts.rows.map(x => [x.strategy_id, x.check_id]), [["strategy:baseline", "check:baseline"], ["strategy:recovery", "check:baseline"]]);
    }
    const lessons = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    assert.equal(lessons.status, 200);
    assert.equal(lessons.value.some((row: any) => row.status === "candidate"), true, "attempt attribution distinguishes strategy even when the trusted check is shared");
  } finally { await ctx.close(); }
});

test("challenger rejects altered or absent reread artifact bytes and rejected challenges cannot promote", async () => {
  const ctx = await setup();
  try {
    const missionId = await createMission(ctx, "fixture/challenge-artifact-tamper", ["tamper-a", "tamper-b"]);
    const episodes = [];
    for (const id of ["tamper-a", "tamper-b"]) {
      const { lease, policy } = await claim(ctx);
      assert.equal(lease.mission.id, missionId);
      episodes.push(await runEpisode(ctx, lease, policy, `tamper-${id}-${randomUUID()}`));
    }
    const listed = await ctx.request("GET", `/api/missions/${missionId}/lessons`, undefined, { cookie: ctx.cookie });
    const candidate = listed.value.find((row: any) => row.status === "candidate");
    assert(candidate);
    const receipt = await ctx.db.query<{ receipt: TrustedCheckReceiptV1 }>("SELECT receipt FROM verification_attempts WHERE attempt_id=$1", [episodes[0]!.baselineAttemptId]);
    const storedReceipt = receipt.rows[0]?.receipt; assert(storedReceipt);
    const artifacts = [
      { hash: storedReceipt.stdout.sha256, bytes: Buffer.from("check failed\n") },
      { hash: storedReceipt.stderr.sha256, bytes: Buffer.alloc(0) },
      { hash: storedReceipt.inputManifest.sha256, bytes: Buffer.from(JSON.stringify({ candidateSha: storedReceipt.request.candidateSha, checkId: storedReceipt.request.checkId })) },
    ];
    let rejectedAttestation: string | undefined;
    for (const artifact of artifacts) {
      ctx.alterArtifact(artifact.hash);
      const altered = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
      assert.equal(altered.status, 200);
      assert.equal(altered.value.decision, "rejected", "challenge recomputation detects altered stdout, stderr or manifest bytes");
      rejectedAttestation = altered.value.attestationDigest;
      ctx.restoreArtifact(artifact.hash, artifact.bytes);
    }
    assert.notEqual((await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, { challengeDigest: rejectedAttestation }, { cookie: ctx.cookie })).status, 200);
    const ref = storedReceipt.stdout.sha256;
    ctx.alterReceiptBlob(episodes[0]!.baselineAttemptId);
    const alteredReceiptBlob = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
    assert.equal(alteredReceiptBlob.status, 200); assert.equal(alteredReceiptBlob.value.decision, "rejected", "the trusted artifact reader durably rejects an altered canonical receipt blob");
    ctx.restoreReceiptBlob(episodes[0]!.baselineAttemptId, storedReceipt);
    const originalReceipt = storedReceipt;
    await ctx.db.query("UPDATE verification_attempts SET receipt=jsonb_set(receipt,'{receiptDigest}',to_jsonb($2::text)) WHERE attempt_id=$1", [episodes[0]!.baselineAttemptId, "0".repeat(64)]);
    const alteredReceipt = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
    assert.equal(alteredReceipt.status, 200); assert.equal(alteredReceipt.value.decision, "rejected", "an altered persisted canonical receipt is durably rejected by the receipt parser");
    await ctx.db.query("UPDATE verification_attempts SET receipt=$2::jsonb WHERE attempt_id=$1", [episodes[0]!.baselineAttemptId, JSON.stringify(originalReceipt)]);
    ctx.removeArtifact(ref);
    const absentArtifact = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
    assert.equal(absentArtifact.status, 200); assert.equal(absentArtifact.value.decision, "rejected", "an absent immutable object is durably rejected during trusted artifact reread");
    assert.notEqual((await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, { challengeDigest: absentArtifact.value.attestationDigest }, { cookie: ctx.cookie })).status, 200);
  } finally { await ctx.close(); }
});

test("challenger rejects four individually trusted observations from four different episodes", async () => {
  const ctx = await setup();
  try {
    const sourceMission = await createMission(ctx, "fixture/cross-episode-challenge", ["pair-a", "pair-b"]);
    for (const id of ["pair-a", "pair-b"]) { const { lease, policy } = await claim(ctx); assert.equal(lease.mission.id, sourceMission); await runEpisode(ctx, lease, policy, `paired-${id}-${randomUUID()}`); }
    const lessons = await ctx.request("GET", `/api/missions/${sourceMission}/lessons`, undefined, { cookie: ctx.cookie });
    const candidate = lessons.value.find((row: any) => row.status === "candidate"); assert(candidate);
    const otherMission = await createMission(ctx, "fixture/cross-episode-challenge", ["only-a", "only-b", "only-c", "only-d"]);
    const isolatedEvents: string[] = [];
    for (const id of ["only-a", "only-b", "only-c", "only-d"]) {
      const { lease, policy } = await claim(ctx); assert.equal(lease.mission.id, otherMission);
      const failed = await trustedProgress(ctx, lease, policy, `single-${id}-${randomUUID()}`, 1, "strategy:baseline", "fail");
      assert.equal((await report(ctx, lease, failed)).status, 200);
      isolatedEvents.push(failed.eventId);
    }
    await ctx.db.query("UPDATE operational_lessons SET evidence_event_ids=$2::jsonb WHERE id=$1", [candidate.id, JSON.stringify(isolatedEvents)]);
    const rejected = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.value.decision, "rejected");
    assert.match(rejected.value.reason, /two distinct comparable episodes/);
    assert.notEqual((await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, { challengeDigest: rejected.value.attestationDigest }, { cookie: ctx.cookie })).status, 200);
  } finally { await ctx.close(); }
});

test("withdrawal during an in-flight lesson-bound judgment quarantines the stale Jev choice", async () => {
  let holdNext = false, signal!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  let gate = new Promise<void>(resolve => { release = resolve; });
  const judge: RecoveryJudgmentAdapter = async snapshot => {
    if (holdNext && snapshot.eventId.startsWith("race-pending")) { holdNext = false; signal(); await gate; }
    const change = snapshot.status === "failed";
    return { version: "orloom.judgment.v1", snapshotDigest: sha(canonicalJson(snapshot)), source: "jev", answer: change ? "change_strategy" : "continue",
      strategyId: change ? "strategy:recovery" : null, checkId: change ? snapshot.alternatives.find(x => x.id === "strategy:recovery")?.policy.checkId ?? null : null,
      policyVersion: "fixture-v1", policyDigest: snapshot.recoveryPolicyDigest, modelId, confidence: 1, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const ctx = await setup({ judgmentAdapter: judge });
  try {
    const sourceMission = await createMission(ctx, "fixture/withdrawal-race", ["source-a", "source-b"]);
    for (const id of ["source-a", "source-b"]) { const { lease, policy } = await claim(ctx); assert.equal(lease.mission.id, sourceMission); await runEpisode(ctx, lease, policy, `race-source-${id}-${randomUUID()}`); }
    const lessons = await ctx.request("GET", `/api/missions/${sourceMission}/lessons`, undefined, { cookie: ctx.cookie });
    const candidate = lessons.value.find((row: any) => row.status === "candidate"); assert(candidate);
    const challenge = await ctx.request("POST", `/api/lessons/${candidate.id}/challenge`, {}, { cookie: ctx.cookie }); assert.equal(challenge.value.decision, "accepted");
    assert.equal((await ctx.request("POST", `/api/lessons/${candidate.id}/promote`, { challengeDigest: challenge.value.attestationDigest }, { cookie: ctx.cookie })).status, 200);

    const raceMission = await createMission(ctx, "fixture/withdrawal-race", ["pending", "withdrawer"]);
    const a = await claim(ctx), b = await claim(ctx); assert.equal(a.lease.mission.id, raceMission); assert.equal(b.lease.mission.id, raceMission);
    holdNext = true;
    const pending = await trustedProgress(ctx, a.lease, a.policy, `race-pending-${randomUUID()}`, 1, "strategy:baseline", "fail");
    const inFlight = report(ctx, a.lease, pending);
    await started;
    const firstFail = await report(ctx, b.lease, await trustedProgress(ctx, b.lease, b.policy, `race-withdrawer-${randomUUID()}`, 1, "strategy:baseline", "fail"));
    assert.equal(firstFail.status, 200);
    const contradiction = await trustedProgress(ctx, b.lease, b.policy, `race-contradiction-${randomUUID()}`, 2, "strategy:recovery", "fail");
    assert.equal((await ctx.db.query<{ bound_lesson_id: string | null }>("SELECT bound_lesson_id FROM verification_attempts WHERE attempt_id=$1", [contradiction.trustedAttemptId])).rows[0]?.bound_lesson_id, candidate.id);
    const withdrawnReceipt = await ctx.store.submitRecoveryVerification!(
      (await ctx.db.query<{ receipt: TrustedCheckReceiptV1 }>("SELECT receipt FROM verification_attempts WHERE attempt_id=$1", [contradiction.trustedAttemptId])).rows[0]!.receipt,
      String((await ctx.db.query<{ capability_hash: string }>("SELECT capability_hash FROM verification_attempts WHERE attempt_id=$1", [contradiction.trustedAttemptId])).rows[0]!.capability_hash),
      contradiction.candidateSha, new Date().toISOString(), sha("race-head-observation"));
    assert.equal(withdrawnReceipt.outcome, "fail");
    const beforeRelease = await ctx.store.getLesson!(candidate.id); assert.equal(beforeRelease?.status, "withdrawn");
    release(); gate = new Promise<void>(resolve => { release = resolve; });
    assert.equal((await inFlight).status, 409, "a result bound to a now-withdrawn lesson cannot commit");
    const quarantined = await ctx.db.query<{ decision_status: string; action: unknown }>("SELECT decision_status,action FROM mission_recovery_progress WHERE event_id=$1", [pending.eventId]);
    assert.equal(quarantined.rows[0]?.decision_status, "unknown"); assert.equal(quarantined.rows[0]?.action, null);
  } finally { release(); await ctx.close(); }
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
        const failed = await report(ctx, lease, await trustedProgress(ctx, lease, policy, `${kind}-failed-${randomUUID()}`, 1, "strategy:baseline", "fail"));
        assert.equal(failed.status, 200);
        assert.equal(failed.value.action.strategyId, "strategy:recovery");
        applyApprovedRecovery(workspace, failed.value.action.strategyId);
        const passedCheck = runFixedCheck(workspace);
        const passedEvent = await trustedProgress(ctx, lease, policy, `${kind}-passed-${randomUUID()}`, 2, "strategy:recovery", "pass");
        const passResult = await report(ctx, lease, passedEvent);
        if (kind.startsWith("unknown")) {
          assert.notEqual(passResult.status, 200);
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

test("terminal progress rejects outcome, check, commit, epoch, policy, target, strategy, attempt reuse and ordering mismatches", async () => {
  const ctx = await setup();
  try {
    await createMission(ctx, "fixture/recovery-binding-matrix", ["binding"]);
    const { lease, policy } = await claim(ctx);
    const valid = await trustedProgress(ctx, lease, policy, `binding-${randomUUID()}`, 1, "strategy:baseline", "fail");
    const variants = [
      { status: "passed", reasonCode: "check_passed" },
      { candidateSha: "a".repeat(40) },
      { leaseEpoch: lease.leaseEpoch + 1 },
      { trustedCheckPolicyDigest: "0".repeat(64) },
      { recoveryPolicyDigest: "0".repeat(64) },
      { targetCheckId: "target:other" },
      { strategyId: "strategy:recovery", checkId: "check:recovery" },
      { checkId: "check:other" },
    ];
    for (const patch of variants) {
      const result = await report(ctx, lease, { ...valid, ...patch, eventId: `bad-${randomUUID()}` });
      assert.notEqual(result.status, 200, `mismatched binding must be rejected: ${JSON.stringify(patch)}`);
    }
    assert.equal((await report(ctx, lease, valid)).status, 200, "the exact trusted binding remains usable after rejected variants");
    assert.notEqual((await report(ctx, lease, { ...valid, eventId: `reuse-${randomUUID()}`, ordinal: 2 })).status, 200, "one attempt cannot be consumed by a second progress event");
    assert.notEqual((await ctx.request("POST", `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/recovery-check`, {
      candidateSha: "b".repeat(40), targetCheckId, strategyId: "strategy:recovery", ordinal: 3,
    }, leaseHeaders(lease))).status, 200, "attempt creation rejects an ordinal gap/reordered strategy before execution");
  } finally { await ctx.close(); }
});

test("prepared recovery attempts cannot drive progress; expired late receipt becomes UNKNOWN and cannot be replayed as FAIL", async () => {
  const ctx = await setup();
  try {
    await createMission(ctx, "fixture/recovery-prepared", ["prepared"]);
    const { lease, policy } = await claim(ctx);
    const event = await trustedProgress(ctx, lease, policy, `prepared-${randomUUID()}`, 1, "strategy:baseline", "fail");
    const saved = await ctx.db.query<{ receipt: unknown; capability_hash: string }>("SELECT receipt,capability_hash FROM verification_attempts WHERE attempt_id=$1", [event.trustedAttemptId]);
    const receipt = saved.rows[0]?.receipt as TrustedCheckReceiptV1;
    const capabilityHash = String(saved.rows[0]?.capability_hash);
    assert(receipt && /^[a-f0-9]{64}$/.test(capabilityHash));
    await ctx.db.query("UPDATE verification_attempts SET outcome=NULL,receipt=NULL,terminal_at=NULL WHERE attempt_id=$1", [event.trustedAttemptId]);
    assert.notEqual((await report(ctx, lease, event)).status, 200, "a prepared attempt without a terminal receipt is not evidence");
    await ctx.db.query("UPDATE verification_attempts SET capability_expires_at=now()-interval '1 second' WHERE attempt_id=$1", [event.trustedAttemptId]);
    const late = await ctx.store.submitRecoveryVerification!(receipt, capabilityHash, event.candidateSha, new Date().toISOString(), sha("late-result-head"));
    assert.equal(late.outcome, "unknown");
    const persisted = await ctx.db.query<{ outcome: string; receipt: unknown }>("SELECT outcome,receipt FROM verification_attempts WHERE attempt_id=$1", [event.trustedAttemptId]);
    assert.equal(persisted.rows[0]?.outcome, "unknown");
    assert.equal(persisted.rows[0]?.receipt, null, "late receipt bytes are not retained as a trusted terminal result");
    await assert.rejects(ctx.store.submitRecoveryVerification!(receipt, capabilityHash, event.candidateSha, new Date().toISOString(), sha("late-result-head")));
    assert.notEqual((await report(ctx, lease, event)).status, 200, "late UNKNOWN cannot be reported as FAIL");

    const unknownMission = await createMission(ctx, "fixture/recovery-unknown-result", ["unknown"]);
    const unknownLease = await claim(ctx); assert.equal(unknownLease.lease.mission.id, unknownMission);
    const unknown = await trustedProgress(ctx, unknownLease.lease, unknownLease.policy, `unknown-${randomUUID()}`, 1, "strategy:baseline", "unknown");
    assert.notEqual((await report(ctx, unknownLease.lease, { ...unknown, status: "failed", reasonCode: "check_failed" })).status, 200, "a persisted trusted UNKNOWN receipt cannot be relabeled as FAIL");
    const unknownRow = await ctx.db.query<{ outcome: string }>("SELECT outcome FROM verification_attempts WHERE attempt_id=$1", [unknown.trustedAttemptId]);
    assert.equal(unknownRow.rows[0]?.outcome, "unknown");
  } finally { await ctx.close(); }
});

test("same-check recovery attempts do not suppress a later final-check dispatch", async () => {
  const ctx = await setup();
  try {
    const missionId = await createMission(ctx, "fixture/final-after-recovery", ["final"]);
    const { lease, policy } = await claim(ctx);
    await ctx.db.query("UPDATE mission_slices SET checks=checks||'[\"check:baseline\"]'::jsonb WHERE mission_id=$1 AND id=$2", [missionId, lease.slice.id]);
    const recovery = await trustedProgress(ctx, lease, policy, `final-recovery-${randomUUID()}`, 1, "strategy:baseline", "fail");
    const sameCheck = await ctx.db.query<{ purpose: string; check_id: string }>("SELECT purpose,check_id FROM verification_attempts WHERE attempt_id=$1", [recovery.trustedAttemptId]);
    assert.deepEqual(sameCheck.rows[0], { purpose: "recovery", check_id: "check:baseline" });
    await ctx.store.complete(missionId, lease.slice.id, lease.leaseEpoch, lease.leaseToken, lease.capabilityToken, recovery.candidateSha, []);
    const pending = await ctx.store.awaitingVerification!(["check:baseline"]);
    assert(pending.some(x => x.missionId === missionId && x.sliceId === lease.slice.id), "a recovery-purpose row cannot suppress final-purpose dispatch");
    await ctx.coordinator.verifySlice(missionId, lease.slice.id);
    const purposes = await ctx.db.query<{ purpose: string; n: number }>("SELECT purpose,count(*)::int AS n FROM verification_attempts WHERE mission_id=$1 AND slice_id=$2 GROUP BY purpose ORDER BY purpose", [missionId, lease.slice.id]);
    assert.deepEqual(purposes.rows.map(x => [x.purpose, Number(x.n)]), [["final", 1], ["recovery", 1]]);
  } finally { await ctx.close(); }
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
    const event = await trustedProgress(ctx, lease, policy, `fenced-${randomUUID()}`, 1, "strategy:baseline", "fail");
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
    const terminalProgress = await trustedProgress(ctx, terminal.lease, terminal.policy, `terminal-${randomUUID()}`, 1, "strategy:baseline", "fail");
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
    const event = await trustedProgress(ctx, lease, policy, `budget-fence-${randomUUID()}`, 1, "strategy:baseline", "fail");
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
    const event = await trustedProgress(ctx, lease, policy, `invalid-continue-${randomUUID()}`, 1, "strategy:baseline", "fail");
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
