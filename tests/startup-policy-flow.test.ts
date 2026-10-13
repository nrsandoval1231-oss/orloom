import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { loadConfig } from "../packages/config/src/config.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionConflictError, type IntegrationRequestV1, type SliceInput } from "../packages/contracts/src/mission.js";
import { receiptDigestV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import { BareGitFastForwardIntegrator } from "../packages/integration/src/local.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { getCheckPolicy } from "../packages/verification/src/policy.js";
import { MissionGovernor, TrustedCheckCoordinator, type TrustedCheckRunner } from "../packages/governor/src/governor.js";

const exec = promisify(callbackExecFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

test("startup-shaped full-suite policy stays distinct from lease digest through integration and exact replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "orloom-startup-policy-"));
  const db = new PGlite();
  try {
    for (const migration of ["001_initial.sql", "002_missions.sql", "003_recovery.sql", "004_verification.sql", "005_learning.sql", "006_integration.sql"]) {
      await db.exec(await readFile(`db/migrations/${migration}`, "utf8"));
    }
    let gate = Promise.resolve();
    const sql: TransactionalSql = {
      query: async (text, params) => await db.query(text, params as never) as never,
      transaction: async work => {
        let release!: () => void;
        const prior = gate;
        gate = new Promise<void>(resolve => { release = resolve; });
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
    const source = join(root, "source"), bare = join(root, "repository.git"), template = join(root, "empty-template");
    await mkdir(template);
    await exec("git", ["init", "-q", "-b", "main", source], { windowsHide: true, timeout: 15_000 });
    await git(source, ["config", "user.name", "Startup fixture"]);
    await git(source, ["config", "user.email", "startup@example.invalid"]);
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

    const imageDigest = hash("startup verifier image"), image = `registry.example/orloom-verifier@sha256:${imageDigest}`;
    const suite = getCheckPolicy("node-repo-suite-v1", image, imageDigest);
    const env = {
      ORLOOM_MODE: "cloud", ORLOOM_DATABASE_URL: "postgres://127.0.0.1/unused-test-db", ORLOOM_HOST: "control.example.test",
      ORLOOM_SESSION_TOKEN: "fixture-session-only", ORLOOM_PUBLIC_ORIGIN: "https://control.example.test",
      ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(["node-repo-suite-v1"]), ORLOOM_VERIFIER_IMAGE: image,
      ORLOOM_VERIFIER_ID: "startup-fixture-runner", ORLOOM_VERIFICATION_POLICY_VERSION: suite.version,
      ORLOOM_INTEGRATION_ENABLED: "true", ORLOOM_INTEGRATION_REPOSITORY: "owner/repo", ORLOOM_INTEGRATION_BARE_REPOSITORY: bare,
      ORLOOM_REVIEW_ARTIFACT_ROOT: root, ORLOOM_DELIVERY_ENABLED: "false"
    } satisfies NodeJS.ProcessEnv;
    const config = loadConfig(env);
    assert(config.trustedCheckPolicyDigest);
    assert(config.trustedCheckPolicy);
    const configuredChecks = config.trustedCheckPolicy;
    assert.notEqual(config.trustedCheckPolicyDigest, suite.digest, "operator lease digest and suite verifier digest are separate domains");

    const store = new SqlMissionStore(sql);
    await store.configureCapacity(1, hash("capacity evidence"), new Date(Date.now() + 120_000).toISOString());
    const mission = await store.submit({ repository: "owner/repo", baseSha: base, objective: "startup-policy integration", acceptance: ["integrate exact trusted candidate"], budgetCents: 100 });
    const slices: SliceInput[] = [
      { id: "parent", objective: "integrate", dependencies: [], owner: "builder", scopes: ["src.txt"], checks: ["node-repo-suite-v1"], budgetCents: 50 },
      { id: "child", objective: "wait", dependencies: ["parent"], owner: "builder-2", scopes: ["docs.txt"], checks: ["node-repo-suite-v1"], budgetCents: 50 }
    ];
    await store.recommendPlan(mission.id, slices, "owner-session");
    await store.approvePlan(mission.id);
    const grant = await store.claim(300, config.trustedCheckPolicyDigest);
    assert(grant);
    await store.complete(mission.id, "parent", grant.epoch, grant.leaseToken, grant.capabilityToken, candidate, []);

    const artifact = { key: `sha256/${hash("trusted artifact")}` as `sha256/${string}`, sha256: hash("trusted artifact"), bytes: 16 };
    const manifest = { key: `sha256/${hash("trusted manifest")}` as `sha256/${string}`, sha256: hash("trusted manifest"), bytes: 17 };
    const runner: TrustedCheckRunner = {
      prepareBundle: async () => ({ digest: hash("input bundle"), manifest: Buffer.from("manifest"), files: new Map() }),
      observeHead: async () => ({ sha: candidate, observedAt: new Date().toISOString(), digest: hash("head observation") }),
      run: async (request: TrustedCheckRequestV1) => {
        const started = new Date();
        const body = { version: "orloom.trusted-check-receipt.v1" as const, request, verifierId: "startup-fixture-runner", runtime: "runsc" as const, sandboxId: "startup-fixture", outcome: "pass" as const, exitCode: 0, startedAt: started.toISOString(), finishedAt: new Date(started.getTime() + 1).toISOString(), stdout: artifact, stderr: artifact, inputManifest: manifest };
        return { ...body, receiptDigest: receiptDigestV1(body) };
      },
      verifyArtifacts: async () => ({ stdout: Buffer.from("stdout"), stderr: Buffer.from("stderr"), manifest: Buffer.from("manifest") })
    };
    const coordinatorFor = (overrides: Partial<{ policyDigest: string; policyVersion: string; imageDigest: string; leasePolicyDigest: string; allowedChecks: string[] }> = {}) => new TrustedCheckCoordinator(store, runner, {
      imageDigest: overrides.imageDigest ?? config.trustedVerifierImageDigest!, verifierId: config.trustedVerifierId!, policyDigest: overrides.policyDigest ?? suite.digest,
      leasePolicyDigest: overrides.leasePolicyDigest ?? config.trustedCheckPolicyDigest!, policyVersion: overrides.policyVersion ?? suite.version,
      allowedChecks: [...(overrides.allowedChecks ?? configuredChecks)], attemptLifetimeMs: 60_000
    });
    const coordinator = coordinatorFor();
    const binding = coordinator.integrationBinding();
    assert.deepEqual(binding.allowedChecks, ["node-repo-suite-v1"]);
    assert.equal(binding.leasePolicyDigest, config.trustedCheckPolicyDigest);
    assert.equal(binding.policyDigest, suite.digest);
    assert.equal(binding.policyVersion, suite.version);
    assert.equal(binding.imageDigest, imageDigest);
    assert.equal(Object.isFrozen(binding), true);
    assert.equal(Object.isFrozen(binding.allowedChecks), true);
    const governor = new MissionGovernor(store, { maxLanes: 2, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: config.trustedCheckPolicyDigest, trustedCheckPolicy: config.trustedCheckPolicy });
    await coordinator.verifySlice(mission.id, "parent");
    const attemptIds = await db.query("SELECT attempt_id,lease_policy_digest FROM verification_attempts WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    assert.equal(attemptIds.rows.length, 1);
    assert.equal((attemptIds.rows[0] as { lease_policy_digest: string }).lease_policy_digest, config.trustedCheckPolicyDigest);
    const attempt = await store.getTrustedAttempt!((attemptIds.rows[0] as { attempt_id: string }).attempt_id);
    assert.equal(attempt?.request.policyDigest, suite.digest);
    assert.equal(attempt?.receipt?.request.policyDigest, suite.digest);
    const integrator = await BareGitFastForwardIntegrator.open(bare, "owner/repo");
    const inspected = await integrator.inspect({ expectedRefSha: base, candidateSha: candidate, scopes: ["src.txt"] });
    const reviewBytes = Buffer.from(canonicalJson({ version: "orloom.independent-review.v1", verdict: "PASS", candidateSha: candidate, treeSha: inspected.treeSha, reviewer: "independent-reviewer", builder: "builder", scopes: ["src.txt"] }));
    const reviewDigest = hash(reviewBytes.toString("utf8"));
    const request: IntegrationRequestV1 = { version: "orloom.integration-request.v1", missionId: mission.id, sliceId: "parent", expectedIntegrationSha: base, candidateSha: candidate, leaseEpoch: grant.epoch, requiredCheckIds: ["node-repo-suite-v1"], reviewArtifactId: "review-1", reviewArtifactDigest: reviewDigest };
    const authority = { integrator, reviews: { read: async (id: string) => id === "review-1" ? reviewBytes : null } };
    let reviewReads = 0, leaseMutationCount = 0;
    const racingAuthority = { integrator, reviews: { read: async (id: string) => {
      if (++reviewReads === 2) {
        await db.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE attempt_id=$1", [(attemptIds.rows[0] as { attempt_id: string }).attempt_id, hash("post-intent lease mutation")]);
        leaseMutationCount++;
      }
      return id === "review-1" ? reviewBytes : null;
    } } };
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, racingAuthority), MissionConflictError, "locked finalization rechecks the original lease domain after Git CAS");
    assert.equal(reviewReads, 2);
    assert.equal(leaseMutationCount, 1, "the final-read race hook must have fired");
    assert.equal((await store.getMission(mission.id))?.slices.find(slice => slice.id === "parent")?.status, "awaiting_verification");
    assert.equal((await store.events(mission.id, 0)).filter(event => event.type === "slice.integrated").length, 0);
    await db.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE attempt_id=$1", [(attemptIds.rows[0] as { attempt_id: string }).attempt_id, config.trustedCheckPolicyDigest]);
    const integrated = await governor.integrateVerifiedSlice(request, coordinator, authority);
    assert.equal(integrated.status, "verified");
    assert.equal((await store.getMission(mission.id))?.slices.find(slice => slice.id === "child")?.status, "ready");
    assert.equal((await store.events(mission.id, 0)).filter(event => event.type === "slice.integrated").length, 1);
    const storedSlice = await db.query("SELECT lease_policy_digest,verification_policy_digest FROM mission_slices WHERE mission_id=$1 AND id='parent'", [mission.id]);
    assert.equal((storedSlice.rows[0] as { lease_policy_digest: string; verification_policy_digest: string }).lease_policy_digest, config.trustedCheckPolicyDigest);
    assert.equal((storedSlice.rows[0] as { lease_policy_digest: string; verification_policy_digest: string }).verification_policy_digest, suite.digest);
    assert.equal((await governor.integrateVerifiedSlice(request, coordinator, authority)).status, "verified", "same full binding permits a fresh exact replay");

    for (const [name, changed] of [
      ["verifier policy", coordinatorFor({ policyDigest: hash("changed suite") })],
      ["verifier version", coordinatorFor({ policyVersion: "changed-suite-version" })],
      ["verifier image", coordinatorFor({ imageDigest: hash("changed image") })],
      ["lease allowed-check digest", coordinatorFor({ leasePolicyDigest: hash("changed allowed-check list") })],
      ["lease allowed-check list", coordinatorFor({ allowedChecks: ["node-repo-suite-v1", "node-validate-syntax"], leasePolicyDigest: hash(JSON.stringify(["node-repo-suite-v1", "node-validate-syntax"])) })]
    ] as const) {
      await assert.rejects(governor.integrateVerifiedSlice(request, changed, authority), MissionConflictError, `changed current ${name} fails exact replay`);
      assert.equal((await store.events(mission.id, 0)).filter(event => event.type === "slice.integrated").length, 1);
    }
    await git(bare, ["update-ref", "refs/heads/orloom-integration", base]);
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, authority), MissionConflictError, "moved local ref fails replay");
    await git(bare, ["update-ref", "refs/heads/orloom-integration", candidate]);
    const savedReceipt = await db.query("SELECT receipt FROM verification_attempts WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    const receiptJson = (savedReceipt.rows[0] as { receipt: unknown }).receipt;
    await db.query("UPDATE verification_attempts SET receipt=NULL WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, authority), MissionConflictError, "missing retained receipt fails replay");
    await db.query("UPDATE verification_attempts SET receipt=$2::jsonb WHERE mission_id=$1 AND slice_id='parent'", [mission.id, canonicalJson(receiptJson)]);
    const savedLease = await db.query("SELECT lease_policy_digest FROM verification_attempts WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    const leaseDigest = (savedLease.rows[0] as { lease_policy_digest: string }).lease_policy_digest;
    await db.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE mission_id=$1 AND slice_id='parent'", [mission.id, hash("altered original lease digest")]);
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, authority), MissionConflictError, "original attempt lease-list mutation fails even with unchanged suite policy");
    await db.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE mission_id=$1 AND slice_id='parent'", [mission.id, leaseDigest]);
    await db.query("UPDATE mission_integration_intents SET state='unknown' WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, authority), MissionConflictError, "UNKNOWN durable intent cannot replay");
    await db.query("UPDATE mission_integration_intents SET state='integrated' WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    await db.query("DELETE FROM check_certificates WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, authority), MissionConflictError, "missing retained certificate fails replay");
    assert.equal((await store.events(mission.id, 0)).filter(event => event.type === "slice.integrated").length, 1);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
