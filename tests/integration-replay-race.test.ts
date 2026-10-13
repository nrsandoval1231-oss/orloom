import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionConflictError, type IntegrationRequestV1, type MissionStore, type MissionSlice, type SliceInput } from "../packages/contracts/src/mission.js";
import { BareGitFastForwardIntegrator, type LocalIntegrator } from "../packages/integration/src/local.js";
import { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { receiptDigestV1, type CheckCertificateV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";

const exec = promisify(callbackExecFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

function barrier() {
  let signal!: () => void;
  let resume!: () => void;
  let used = false;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  return {
    reached,
    release: () => resume(),
    pause: async () => {
      if (used) return;
      used = true;
      signal();
      await released;
    }
  };
}
async function waitAtBarrier(value: ReturnType<typeof barrier>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([value.reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("replay race barrier was not reached")), 10_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

const governorConfig = (policyDigest: string) => ({ maxLanes: 2, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: policyDigest, trustedCheckPolicy: ["node-repo-suite-v1"] });
const leasePolicyDigest = hash(JSON.stringify(["node-repo-suite-v1"]));

async function makeFixture(db: PGlite, store: SqlMissionStore, root: string, label: string, policy: string) {
  const repoRoot = join(root, label), source = join(repoRoot, "source"), bare = join(repoRoot, "bare"), template = join(repoRoot, "empty-template");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(template);
  await exec("git", ["init", "-q", "-b", "main", source], { windowsHide: true, timeout: 15_000 });
  await git(source, ["config", "user.name", "Replay fixture"]);
  await git(source, ["config", "user.email", "replay@example.invalid"]);
  await writeFile(join(source, "src.txt"), "base\n");
  await git(source, ["add", "src.txt"]);
  await git(source, ["commit", "-qm", "base"]);
  const base = await git(source, ["rev-parse", "HEAD"]);
  await exec("git", ["clone", "-q", "--bare", `--template=${template}`, source, bare], { windowsHide: true, timeout: 15_000 });
  await git(bare, ["update-ref", "refs/heads/orloom-integration", base]);
  await writeFile(join(source, "src.txt"), "candidate\n");
  await git(source, ["commit", "-qam", "candidate"]);
  const candidate = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["push", "-q", bare, `${candidate}:refs/heads/candidate`]);

  const repositoryIdentity = `owner/${label}`;
  const integrator = await BareGitFastForwardIntegrator.open(bare, repositoryIdentity);
  const inspected = await integrator.inspect({ expectedRefSha: base, candidateSha: candidate, scopes: ["src.txt"] });
  let successfulCas = 0;
  const local: LocalIntegrator = {
    repositoryIdentity: integrator.repositoryIdentity,
    inspect: (request) => integrator.inspect(request),
    readRef: () => integrator.readRef(),
    compareAndSwap: async (request) => {
      const result = await integrator.compareAndSwap(request);
      if (result.previousSha === base && result.candidateSha === candidate) successfulCas++;
      return result;
    }
  };

  const mission = await store.submit({ repository: repositoryIdentity, baseSha: base, objective: label, acceptance: ["exact local integration"], budgetCents: 100 });
  const slices: SliceInput[] = [
    { id: "parent", objective: "integrate candidate", dependencies: [], owner: "builder", scopes: ["src.txt"], checks: ["node-repo-suite-v1"], budgetCents: 50 },
    { id: "child", objective: "wait for parent", dependencies: ["parent"], owner: "builder-2", scopes: ["docs.txt"], checks: ["node-repo-suite-v1"], budgetCents: 50 }
  ];
  await store.recommendPlan(mission.id, slices, "owner-session");
  await store.approvePlan(mission.id);
  const grant = await store.claim(300, leasePolicyDigest);
  assert(grant);
  assert.equal(grant.mission.id, mission.id);
  assert.equal(grant.slice.id, "parent");
  await store.complete(mission.id, "parent", grant.epoch, grant.leaseToken, grant.capabilityToken, candidate, []);

  const artifact = { key: `sha256/${hash("stdout")}`, sha256: hash("stdout"), bytes: 6 } as const;
  const manifest = { key: `sha256/${hash("manifest")}`, sha256: hash("manifest"), bytes: 8 } as const;
  const runner = {
    prepareBundle: async () => ({ digest: hash("bundle"), manifest: Buffer.from("manifest"), files: new Map<string, Buffer>() }),
    observeHead: async () => ({ sha: candidate, observedAt: new Date().toISOString(), digest: hash(`head:${candidate}`) }),
    run: async (request: TrustedCheckRequestV1) => {
      const started = new Date();
      const body = { version: "orloom.trusted-check-receipt.v1" as const, request, verifierId: "fixture-verifier", runtime: "runsc" as const, sandboxId: label, outcome: "pass" as const, exitCode: 0, startedAt: started.toISOString(), finishedAt: new Date(started.getTime() + 1).toISOString(), stdout: artifact, stderr: artifact, inputManifest: manifest };
      return { ...body, receiptDigest: receiptDigestV1(body) } satisfies TrustedCheckReceiptV1;
    },
    verifyArtifacts: async () => ({ stdout: Buffer.from("stdout"), stderr: Buffer.from("stderr"), manifest: Buffer.from("manifest") })
  };
  const coordinator = new TrustedCheckCoordinator(store, runner, { imageDigest: hash("image"), verifierId: "fixture-verifier", policyDigest: policy, leasePolicyDigest, policyVersion: "fixture-v1", allowedChecks: ["node-repo-suite-v1"], attemptLifetimeMs: 60_000 });
  const governor = new MissionGovernor(store, governorConfig(leasePolicyDigest));
  await coordinator.verifySlice(mission.id, "parent");

  const reviewId = `review-${label}`;
  const reviewBytes = Buffer.from(canonicalJson({ version: "orloom.independent-review.v1", verdict: "PASS", candidateSha: candidate, treeSha: inspected.treeSha, reviewer: "separate-reviewer", builder: "builder", scopes: ["src.txt"] }));
  const reviews = { read: async (id: string) => id === reviewId ? reviewBytes : null };
  const request: IntegrationRequestV1 = { version: "orloom.integration-request.v1", missionId: mission.id, sliceId: "parent", expectedIntegrationSha: base, candidateSha: candidate, leaseEpoch: grant.epoch, requiredCheckIds: ["node-repo-suite-v1"], reviewArtifactId: reviewId, reviewArtifactDigest: hash(reviewBytes.toString()) };
  let reviewReads = 0;
  const interrupted = { integrator: local, reviews: { read: async (id: string) => { if (++reviewReads === 2) throw new Error("controlled interruption after CAS"); return reviews.read(id); } } };
  await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, interrupted), /controlled interruption after CAS/);
  assert.equal(await local.readRef(), candidate);
  assert.equal((await store.getIntegrationIntent!(request))?.state, "pending");
  assert.equal(successfulCas, 1);
  return { store, governor, coordinator, authority: { integrator: local, reviews }, request, candidate, base, missionId: mission.id, reviewBytes, successfulCas: () => successfulCas };
}

function delayedStore(base: SqlMissionStore, point: string, gate: ReturnType<typeof barrier>, missionId: string): SqlMissionStore {
  const store = Object.create(base) as SqlMissionStore;
  if (point === "pending-intent") {
    store.getIntegrationIntent = async (request) => {
      const intent = await base.getIntegrationIntent!(request);
      if (intent?.state === "pending") await gate.pause();
      return intent;
    };
  }
  if (point === "slice-read") {
    store.getMission = async (id) => {
      if (id === missionId) await gate.pause();
      return base.getMission(id);
    };
  }
  if (point === "finish") {
    store.finishIntegrationIntent = async (request, observed, tree, binding) => {
      await gate.pause();
      return base.finishIntegrationIntent!(request, observed, tree, binding);
    };
  }
  return store;
}

function delayedCoordinator(base: TrustedCheckCoordinator, gate: ReturnType<typeof barrier>, targetCall: number) {
  const coordinator = Object.create(base) as TrustedCheckCoordinator;
  let calls = 0;
  coordinator.getCertificate = async (missionId: string, sliceId: string, checkId: string): Promise<CheckCertificateV1 | null> => {
    if (++calls === targetCall) await gate.pause();
    return base.getCertificate(missionId, sliceId, checkId);
  };
  return coordinator;
}

const testSql = (db: PGlite): TransactionalSql => {
  let tail = Promise.resolve();
  return {
    query: async (text, params) => await db.query(text, params as never) as never,
    transaction: async <T>(work: (tx: { query: TransactionalSql["query"] }) => Promise<T>) => {
      let release!: () => void;
      const prior = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
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
    }
  };
};

test("completed exact integration replays reconcile across each pre-finalization race gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "orloom-c4-replay-"));
  const db = new PGlite();
  try {
    for (const migration of ["001_initial.sql", "002_missions.sql", "003_recovery.sql", "004_verification.sql", "005_learning.sql", "006_integration.sql"]) await db.exec(await readFile(join("db", "migrations", migration), "utf8"));
    const sql = testSql(db), store = new SqlMissionStore(sql), policy = hash("replay-race-policy");
    await store.configureCapacity(1, hash("replay-race-capacity"), new Date(Date.now() + 300_000).toISOString());
    const gates = [
      { name: "pending-intent-read", storePoint: "pending-intent" },
      { name: "awaiting-slice-read", storePoint: "slice-read" },
      { name: "initial-certificate-read", certificateCall: 1 },
      { name: "final-certificate-read", certificateCall: 2 },
      { name: "sql-finalization", storePoint: "finish" }
    ];
    const fixtures = [] as Awaited<ReturnType<typeof makeFixture>>[];
    for (const [index, point] of gates.entries()) {
      const fixture = await makeFixture(db, store, root, `race-${index + 1}`, policy);
      fixtures.push(fixture);
      const gate = barrier();
      const secondStore = delayedStore(store, point.storePoint ?? "", gate, fixture.missionId);
      const secondCoordinator = point.certificateCall ? delayedCoordinator(fixture.coordinator, gate, point.certificateCall) : fixture.coordinator;
      const secondGovernor = new MissionGovernor(secondStore, governorConfig(leasePolicyDigest));
      const secondCall = secondGovernor.integrateVerifiedSlice(fixture.request, secondCoordinator, fixture.authority);
      try {
        await waitAtBarrier(gate);
        const first = await fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority);
        assert.equal(first.status, "verified", `${point.name}: first finalizer succeeds`);
        gate.release();
        const second = await secondCall;
        assert.equal(second.status, "verified", `${point.name}: exact pending replay reconciles`);
        assert.equal(second.missionId, fixture.missionId);
        assert.equal(second.id, "parent");
        assert.equal(fixture.successfulCas(), 1, `${point.name}: only the original request moved the Git ref`);
        assert.equal((await store.events(fixture.missionId, 0)).filter(event => event.type === "slice.integrated").length, 1, `${point.name}: one integration event`);
        assert.equal((await store.getMission(fixture.missionId))?.slices.find(slice => slice.id === "child")?.status, "ready", `${point.name}: dependent released once`);
      } finally {
        gate.release();
        await secondCall.catch(() => undefined);
      }
    }

    const fixture = fixtures[0]!;
    const eventCount = async () => (await store.events(fixture.missionId, 0)).filter(event => event.type === "slice.integrated").length;
    const childStatus = async () => (await store.getMission(fixture.missionId))?.slices.find(slice => slice.id === "child")?.status;
    const assertNoReplayEffects = async () => { assert.equal(await eventCount(), 1); assert.equal(await childStatus(), "ready"); assert.equal(fixture.successfulCas(), 1); };

    const wrongReviewRequest = { ...fixture.request, reviewArtifactDigest: hash("wrong review") };
    await assert.rejects(fixture.governor.integrateVerifiedSlice(wrongReviewRequest, fixture.coordinator, fixture.authority), MissionConflictError, "conflicting request digest is rejected");
    await assertNoReplayEffects();

    const receiptRow = await db.query("SELECT certificate_id,receipt FROM check_certificates WHERE mission_id=$1 AND slice_id='parent' AND check_id='node-repo-suite-v1'", [fixture.missionId]);
    assert.equal(receiptRow.rows.length, 1);
    const certRow = receiptRow.rows[0] as { certificate_id: string; receipt: unknown };
    const originalCertificateReceipt = certRow.receipt;
    await db.query("UPDATE check_certificates SET receipt=jsonb_set(receipt,'{request,policyVersion}',to_jsonb('tampered'::text),false) WHERE certificate_id=$1", [certRow.certificate_id]);
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), MissionConflictError, "replay SQL fence rereads certificate receipt bytes");
    await assertNoReplayEffects();
    await db.query("UPDATE check_certificates SET receipt=$2::jsonb WHERE certificate_id=$1", [certRow.certificate_id, canonicalJson(originalCertificateReceipt)]);

    const originalPlan = await db.query("SELECT slices FROM mission_plans WHERE mission_id=$1", [fixture.missionId]);
    const planSlices = (originalPlan.rows[0] as { slices: unknown }).slices;
    await db.query("UPDATE mission_plans SET slices=jsonb_set(slices,'{0,objective}',to_jsonb('changed approved plan'::text),false) WHERE mission_id=$1", [fixture.missionId]);
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), MissionConflictError, "changed approved plan is rejected during replay");
    await assertNoReplayEffects();
    await db.query("UPDATE mission_plans SET slices=$2::jsonb WHERE mission_id=$1", [fixture.missionId, canonicalJson(planSlices)]);

    const policyRow = await db.query("SELECT verification_policy_digest FROM mission_slices WHERE mission_id=$1 AND id='parent'", [fixture.missionId]);
    const originalPolicy = String((policyRow.rows[0] as { verification_policy_digest: string }).verification_policy_digest);
    await db.query("UPDATE mission_slices SET verification_policy_digest=$2 WHERE mission_id=$1 AND id='parent'", [fixture.missionId, hash("changed replay policy")]);
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), MissionConflictError, "changed policy binding is rejected during replay");
    await assertNoReplayEffects();
    await db.query("UPDATE mission_slices SET verification_policy_digest=$2 WHERE mission_id=$1 AND id='parent'", [fixture.missionId, originalPolicy]);

    const originalTree = await db.query("SELECT tree_sha FROM mission_integration_intents WHERE mission_id=$1 AND slice_id='parent'", [fixture.missionId]);
    const treeSha = String((originalTree.rows[0] as { tree_sha: string }).tree_sha);
    await db.query("UPDATE mission_integration_intents SET tree_sha=$2 WHERE mission_id=$1 AND slice_id='parent'", [fixture.missionId, hash("changed tree").slice(0, 40)]);
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), MissionConflictError, "changed durable tree binding is rejected");
    await assertNoReplayEffects();
    await db.query("UPDATE mission_integration_intents SET tree_sha=$2 WHERE mission_id=$1 AND slice_id='parent'", [fixture.missionId, treeSha]);

    await git(join(root, "race-1", "bare"), ["update-ref", "refs/heads/orloom-integration", fixture.base]);
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), MissionConflictError, "moved local integration ref cannot replay success");
    await assertNoReplayEffects();
    await git(join(root, "race-1", "bare"), ["update-ref", "refs/heads/orloom-integration", fixture.candidate]);

    await db.query("UPDATE mission_integration_intents SET state='unknown' WHERE mission_id=$1 AND slice_id='parent'", [fixture.missionId]);
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), MissionConflictError, "UNKNOWN durable intent cannot replay success");
    await assertNoReplayEffects();
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
