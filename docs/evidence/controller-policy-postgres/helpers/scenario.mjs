import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

// Actual SqlMissionStore, Governor and trusted-check coordinator against the
// bounded local PostgreSQL runner. Git, verifier receipts and review are controlled fixtures.
const source = resolve(process.env.C4_PG_SOURCE ?? "");
const configPath = resolve(process.env.C4_PG_CONFIG ?? "");
const evidence = resolve(process.env.C4_PG_EVIDENCE ?? "");
const runtime = resolve(process.env.C4_PG_RUNTIME ?? dirname(evidence));
const expectedSha = process.env.C4_PG_EXPECTED_SHA ?? "";
if (!process.env.C4_PG_SOURCE || !process.env.C4_PG_CONFIG || !process.env.C4_PG_EVIDENCE) throw new Error("runner paths are incomplete");
if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("missing frozen candidate binding");
const evidenceRelative = relative(runtime, evidence);
if (!evidenceRelative || evidenceRelative === ".." || evidenceRelative.startsWith(`..${sep}`)) throw new Error("evidence directory must be beneath the dedicated runtime root");

const connection = JSON.parse(await readFile(configPath, "utf8"));
const sourceLoad = (relativePath) => import(pathToFileURL(join(source, "dist", relativePath)).href);
const pgNamespace = await import(pathToFileURL(join(source, "node_modules", "pg", "lib", "index.js")).href);
const Pool = pgNamespace.default?.Pool;
if (typeof Pool !== "function") throw new Error("pg default export is not a Pool constructor");
const [
  { SqlMissionStore },
  { BareGitFastForwardIntegrator },
  { TrustedCheckCoordinator, MissionGovernor },
  { loadConfig },
  { getCheckPolicy },
  { canonicalJson },
  { receiptDigestV1 },
] = await Promise.all([
  sourceLoad("packages/contracts/src/sql-mission-store.js"),
  sourceLoad("packages/integration/src/local.js"),
  sourceLoad("packages/governor/src/governor.js"),
  sourceLoad("packages/config/src/config.js"),
  sourceLoad("packages/verification/src/policy.js"),
  sourceLoad("packages/judgment/src/canonical.js"),
  sourceLoad("packages/contracts/src/verification.js"),
]);

const execFile = promisify(execFileCallback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hashArtifact = (bytes) => {
  const sha256 = digest(bytes);
  return { key: `sha256/${sha256}`, sha256, bytes: bytes.byteLength };
};
const rows = [];
let phase = "migrations";
const note = async (name, details = {}) => {
  const item = { at: new Date().toISOString(), name, ...details };
  rows.push(item);
  await appendFile(join(evidence, "startup-policy-scenario.jsonl"), `${JSON.stringify(item)}\n`);
};

function sql(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (text, params) => client.query(text, params) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* retain original SQL failure */ }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const noGlobalGitConfig = process.platform === "win32" ? "NUL" : "/dev/null";
async function git(cwd, args) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: noGlobalGitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const result = await execFile("git", [
    "-c", `core.hooksPath=${noGlobalGitConfig}`,
    "-c", `core.attributesFile=${noGlobalGitConfig}`,
    "-c", "core.fsmonitor=false", "-c", "diff.external=", "--no-pager", "-C", cwd, ...args,
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env });
  return result.stdout.trim();
}

async function createBareRepository() {
  const root = join(runtime, "f", "1");
  const sourceRepo = join(root, "s"), bareRepo = join(root, "b"), template = join(root, "t");
  const objectPathLength = Math.max(
    join(bareRepo, "objects", "ff", "a".repeat(38)).length,
    join(sourceRepo, ".git", "objects", "ff", "a".repeat(38)).length,
  );
  assert(objectPathLength <= 230, `temporary Git object path budget exceeded (${objectPathLength}/230)`);
  await note("temporary-git-path-budget", { objectPathLength, limit: 230 });
  await mkdir(root, { recursive: true });
  await mkdir(template);
  await git(root, ["init", "-q", "-b", "main", "s"]);
  await git(sourceRepo, ["config", "user.name", "Startup policy fixture"]);
  await git(sourceRepo, ["config", "user.email", "startup-policy@example.invalid"]);
  await writeFile(join(sourceRepo, "source.txt"), "base\n", { flag: "wx" });
  await git(sourceRepo, ["add", "source.txt"]);
  await git(sourceRepo, ["commit", "-qm", "controlled base"]);
  const baseSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
  const baseTree = await git(sourceRepo, ["rev-parse", "HEAD^{tree}"]);
  await git(root, ["clone", "-q", "--bare", "--template=t", "s", "b"]);
  await git(bareRepo, ["update-ref", "refs/heads/orloom-integration", baseSha]);
  await writeFile(join(sourceRepo, "source.txt"), "candidate\n");
  await git(sourceRepo, ["commit", "-qam", "controlled candidate"]);
  const candidateSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
  const candidateTree = await git(sourceRepo, ["rev-parse", "HEAD^{tree}"]);
  await git(sourceRepo, ["push", "-q", bareRepo, `${candidateSha}:refs/heads/candidate`]);
  return { root, bareRepo, baseSha, baseTree, candidateSha, candidateTree };
}

const firstPool = new Pool({ ...connection, max: 8, application_name: "startup-policy-primary" });
const secondPool = new Pool({ ...connection, max: 6, application_name: "startup-policy-independent" });
try {
  assert.equal((await firstPool.query("SELECT 1 AS connected")).rows[0].connected, 1);
  assert.equal((await secondPool.query("SELECT 1 AS connected")).rows[0].connected, 1);
  const migrations = (await readdir(join(source, "db", "migrations"))).filter(name => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
  assert(migrations.length > 0, "candidate contains canonical SQL migrations");
  for (const migration of migrations) await firstPool.query(await readFile(join(source, "db", "migrations", migration), "utf8"));
  assert.equal(Number((await secondPool.query("SELECT count(*) AS count FROM information_schema.tables WHERE table_schema='public' AND table_name='mission_slices'")).rows[0].count), 1);
  const store = new SqlMissionStore(sql(firstPool));
  const independentStore = new SqlMissionStore(sql(secondPool));
  await store.configureCapacity(1, digest("startup-policy-capacity"), new Date(Date.now() + 120_000).toISOString());

  phase = "startup-policy-binding";
  const imageDigest = digest("startup policy controlled verifier image");
  const image = `registry.example/orloom-verifier@sha256:${imageDigest}`;
  const suite = getCheckPolicy("node-repo-suite-v1", image, imageDigest);
  const env = {
    ORLOOM_MODE: "cloud",
    ORLOOM_DATABASE_URL: "postgresql://127.0.0.1/fixture-database-not-used-by-loadConfig",
    ORLOOM_HOST: "control.example.test",
    ORLOOM_SESSION_TOKEN: "controlled-session-placeholder",
    ORLOOM_PUBLIC_ORIGIN: "https://control.example.test",
    ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(["node-repo-suite-v1"]),
    ORLOOM_VERIFIER_IMAGE: image,
    ORLOOM_VERIFIER_ID: "startup-policy-fixture-verifier",
    ORLOOM_VERIFICATION_POLICY_VERSION: suite.version,
    ORLOOM_INTEGRATION_ENABLED: "true",
    ORLOOM_INTEGRATION_REPOSITORY: "owner/repo",
    ORLOOM_INTEGRATION_BARE_REPOSITORY: join(runtime, "f", "1", "b"),
    ORLOOM_REVIEW_ARTIFACT_ROOT: join(runtime, "reviews"),
    ORLOOM_DELIVERY_ENABLED: "false",
  };
  const config = loadConfig(env);
  assert(config.trustedCheckPolicyDigest, "loadConfig produced operator lease policy digest");
  assert.deepEqual(config.trustedCheckPolicy, ["node-repo-suite-v1"]);
  assert.notEqual(config.trustedCheckPolicyDigest, suite.digest, "operator lease and verifier policy digests are distinct");
  assert.equal(config.trustedVerifierImageDigest, imageDigest);
  assert.equal(config.trustedVerificationPolicyVersion, suite.version);
  await note("startup-policy-domains", { leasePolicyDigest: config.trustedCheckPolicyDigest, verifierPolicyDigest: suite.digest, policyVersion: suite.version, imageDigest });

  phase = "mission-claim-complete";
  const gitFixture = await createBareRepository();
  const repository = "owner/repo";
  const mission = await store.submit({ repository, baseSha: gitFixture.baseSha, objective: "verify startup policy-domain composition", acceptance: ["integrate the exact trusted candidate"], budgetCents: 100 });
  const slices = [
    { id: "parent", objective: "verify and integrate candidate", dependencies: [], owner: "builder", scopes: ["source.txt"], checks: ["node-repo-suite-v1"], budgetCents: 50 },
    { id: "child", objective: "wait for parent integration", dependencies: ["parent"], owner: "builder-child", scopes: ["docs.txt"], checks: ["node-repo-suite-v1"], budgetCents: 50 },
  ];
  await store.recommendPlan(mission.id, slices, "startup-policy-fixture");
  await store.approvePlan(mission.id);
  const grant = await store.claim(300, config.trustedCheckPolicyDigest);
  assert(grant, "the configured operator policy grants the verifier lease");
  assert.equal(grant.mission.id, mission.id);
  assert.equal(grant.slice.id, "parent");
  await store.complete(mission.id, "parent", grant.epoch, grant.leaseToken, grant.capabilityToken, gitFixture.candidateSha, []);

  phase = "controlled-final-certificate";
  const stdout = Buffer.from("controlled startup policy receipt stdout");
  const stderr = Buffer.from("controlled startup policy receipt stderr");
  const inputManifest = Buffer.from("controlled startup policy input manifest");
  const runner = {
    prepareBundle: async () => ({ digest: digest("controlled bundle"), manifest: Buffer.from("controlled bundle manifest"), files: new Map() }),
    observeHead: async () => ({ sha: gitFixture.candidateSha, observedAt: new Date().toISOString(), digest: digest(`head:${gitFixture.candidateSha}`) }),
    run: async request => {
      const started = new Date();
      const body = {
        version: "orloom.trusted-check-receipt.v1", request,
        verifierId: config.trustedVerifierId, runtime: "runsc", sandboxId: "controlled-startup-policy-fixture",
        outcome: "pass", exitCode: 0,
        startedAt: started.toISOString(), finishedAt: new Date(started.getTime() + 1).toISOString(),
        stdout: hashArtifact(stdout), stderr: hashArtifact(stderr), inputManifest: hashArtifact(inputManifest),
      };
      return { ...body, receiptDigest: receiptDigestV1(body) };
    },
    verifyArtifacts: async () => ({ stdout, stderr, manifest: inputManifest }),
  };
  const coordinatorFor = (overrides = {}) => new TrustedCheckCoordinator(store, runner, {
    imageDigest: overrides.imageDigest ?? config.trustedVerifierImageDigest,
    verifierId: config.trustedVerifierId,
    policyDigest: overrides.policyDigest ?? suite.digest,
    leasePolicyDigest: overrides.leasePolicyDigest ?? config.trustedCheckPolicyDigest,
    policyVersion: overrides.policyVersion ?? suite.version,
    allowedChecks: [...(overrides.allowedChecks ?? config.trustedCheckPolicy)],
    attemptLifetimeMs: 60_000,
  });
  const coordinator = coordinatorFor();
  const binding = coordinator.integrationBinding();
  assert.deepEqual(binding.allowedChecks, ["node-repo-suite-v1"]);
  assert.equal(binding.leasePolicyDigest, config.trustedCheckPolicyDigest);
  assert.equal(binding.policyDigest, suite.digest);
  assert.equal(binding.policyVersion, suite.version);
  assert.equal(binding.imageDigest, imageDigest);
  assert(Object.isFrozen(binding));
  assert(Object.isFrozen(binding.allowedChecks));
  const governor = new MissionGovernor(store, {
    maxLanes: config.maxLanes,
    capacitySlots: 1,
    leaseSeconds: 300,
    trustedCheckPolicyDigest: config.trustedCheckPolicyDigest,
    trustedCheckPolicy: config.trustedCheckPolicy,
    executionConfigured: true,
  });
  await coordinator.verifySlice(mission.id, "parent");
  const attemptRows = await secondPool.query("SELECT attempt_id,purpose,outcome,lease_policy_digest,request,receipt FROM verification_attempts WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
  assert.equal(attemptRows.rows.length, 1);
  const attempt = attemptRows.rows[0];
  assert.equal(attempt.purpose, "final");
  assert.equal(attempt.outcome, "pass");
  assert.equal(attempt.lease_policy_digest, config.trustedCheckPolicyDigest, "SQL retains the operator lease digest");
  assert.equal(attempt.request.policyDigest, suite.digest, "trusted attempt request records verifier policy digest");
  assert.equal(attempt.receipt.request.policyDigest, suite.digest, "receipt preserves verifier policy digest");
  const certificate = await coordinator.getCertificate(mission.id, "parent", "node-repo-suite-v1");
  assert(certificate);
  assert.equal(certificate.policyDigest, suite.digest);
  assert.equal(certificate.policyVersion, suite.version);
  assert.equal(attempt.request.verifierImageDigest, imageDigest, "attempt binds the configured pinned image digest");
  const sliceBeforeIntegration = await secondPool.query("SELECT lease_policy_digest,verification_policy_digest FROM mission_slices WHERE mission_id=$1 AND id='parent'", [mission.id]);
  assert.equal(sliceBeforeIntegration.rows[0].lease_policy_digest, config.trustedCheckPolicyDigest);
  assert.equal(sliceBeforeIntegration.rows[0].verification_policy_digest, suite.digest);
  await note("policy-domain-readback", { leasePolicyDigest: attempt.lease_policy_digest, requestPolicyDigest: attempt.request.policyDigest, certificatePolicyDigest: certificate.policyDigest, sliceLeasePolicyDigest: sliceBeforeIntegration.rows[0].lease_policy_digest, sliceVerifierPolicyDigest: sliceBeforeIntegration.rows[0].verification_policy_digest });

  phase = "controlled-local-integration";
  const integrator = await BareGitFastForwardIntegrator.open(gitFixture.bareRepo, repository);
  const inspected = await integrator.inspect({ expectedRefSha: gitFixture.baseSha, candidateSha: gitFixture.candidateSha, scopes: ["source.txt"] });
  assert.equal(inspected.treeSha, gitFixture.candidateTree);
  const reviewBytes = Buffer.from(canonicalJson({
    version: "orloom.independent-review.v1", verdict: "PASS",
    candidateSha: gitFixture.candidateSha, treeSha: inspected.treeSha,
    reviewer: "controlled-independent-review-fixture", builder: "builder", scopes: ["source.txt"],
  }));
  const reviewDigest = digest(reviewBytes);
  const request = {
    version: "orloom.integration-request.v1", missionId: mission.id, sliceId: "parent",
    expectedIntegrationSha: gitFixture.baseSha, candidateSha: gitFixture.candidateSha,
    leaseEpoch: grant.epoch, requiredCheckIds: ["node-repo-suite-v1"],
    reviewArtifactId: "controlled-review-001", reviewArtifactDigest: reviewDigest,
  };
  let compareAndSwapCalls = 0;
  const authority = {
    integrator: {
      repositoryIdentity: repository,
      inspect: input => integrator.inspect(input),
      readRef: () => integrator.readRef(),
      compareAndSwap: input => { compareAndSwapCalls++; return integrator.compareAndSwap(input); },
    },
    reviews: { read: async id => id === request.reviewArtifactId ? reviewBytes : null },
  };
  const integrated = await governor.integrateVerifiedSlice(request, coordinator, authority);
  assert.equal(integrated.status, "verified");
  assert.equal(integrated.candidateSha, gitFixture.candidateSha);
  assert.equal(await integrator.readRef(), gitFixture.candidateSha);
  assert.equal(compareAndSwapCalls, 1, "one local CAS integrates exact candidate");
  assert.equal((await secondPool.query("SELECT count(*) AS count FROM mission_events WHERE mission_id=$1 AND type='slice.integrated'", [mission.id])).rows[0].count, "1");
  assert.equal((await independentStore.getMission(mission.id)).slices.find(slice => slice.id === "child").status, "ready");

  phase = "completed-exact-replay";
  const replay = await governor.integrateVerifiedSlice(request, coordinator, authority);
  assert.equal(replay.status, "verified");
  assert.equal(compareAndSwapCalls, 1, "exact replay reads retained evidence without a second CAS");
  const intent = await store.getIntegrationIntent(request);
  assert.equal(intent.state, "integrated");
  assert.equal(intent.observedIntegrationSha, gitFixture.candidateSha);
  const intentPolicy = await secondPool.query("SELECT state,policy_digest,observed_integration_sha FROM mission_integration_intents WHERE mission_id=$1 AND slice_id='parent'", [mission.id]);
  assert.equal(intentPolicy.rows[0].state, "integrated");
  assert.equal(intentPolicy.rows[0].policy_digest, suite.digest, "durable integration intent stores verifier policy digest");
  assert.equal(intentPolicy.rows[0].observed_integration_sha, gitFixture.candidateSha);

  phase = "negative-policy-fences";
  const mutations = [
    ["current suite policy", { policyDigest: digest("changed current suite policy") }],
    ["current verifier image", { imageDigest: digest("changed current verifier image") }],
    ["current policy version", { policyVersion: `${suite.version}.changed` }],
    ["current lease policy", { leasePolicyDigest: digest("changed current lease policy") }],
  ];
  for (const [name, overrides] of mutations) {
    await assert.rejects(governor.integrateVerifiedSlice(request, coordinatorFor(overrides), authority), /./, `${name} must reject completed replay`);
    assert.equal(compareAndSwapCalls, 1, `${name} rejection causes no second CAS`);
  }
  await secondPool.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE attempt_id=$1", [attempt.attempt_id, digest("mutated retained attempt lease")]);
  await assert.rejects(governor.integrateVerifiedSlice(request, coordinator, authority), /./, "mutated retained attempt lease digest must reject exact replay");
  await secondPool.query("UPDATE verification_attempts SET lease_policy_digest=$2 WHERE attempt_id=$1", [attempt.attempt_id, config.trustedCheckPolicyDigest]);
  assert.equal((await secondPool.query("SELECT count(*) AS count FROM mission_events WHERE mission_id=$1 AND type='slice.integrated'", [mission.id])).rows[0].count, "1", "negative replays do not create another integration event");
  assert.equal(compareAndSwapCalls, 1);
  await note("policy-replay-fences", { rejected: mutations.map(([name]) => name).concat("mutated retained attempt lease digest"), compareAndSwapCalls });

  phase = "complete";
  const summary = {
    candidateSha: expectedSha,
    policyDomains: {
      leasePolicyDigest: config.trustedCheckPolicyDigest,
      verifierPolicyDigest: suite.digest,
      policyVersion: suite.version,
      imageDigest,
      distinct: config.trustedCheckPolicyDigest !== suite.digest,
    },
    databaseBehavior: "local real PostgreSQL via production SqlMissionStore, Governor and TrustedCheckCoordinator; two independent pg pools",
    lifecycle: [`all ${migrations.length} canonical SQL migrations`, "loadConfig", "getCheckPolicy(node-repo-suite-v1, digest-pinned image)", "claim with operator lease digest", "complete candidate", "controlled trusted PASS receipt and certificate", "first-time local bare-Git CAS integration", "exact retained-evidence replay"],
    assertions: rows,
    controls: {
      controlledOnly: ["Git fixture", "verifier receipt/artifacts", "independent-review bytes"],
      externalProviderCalls: 0,
      externalNetworkCalls: 0,
      runtimeSandboxClaims: false,
      actualFullSuiteClaim: false,
      hostOrDeploymentCalls: 0,
    },
    limitations: [
      "The verifier receipt and independent-review artifact are controlled fixture data; they do not establish authentic CI or third-party review.",
      "This proves PostgreSQL-backed startup policy-domain behavior only, not a full-suite run or production readiness.",
    ],
  };
  await writeFile(join(evidence, "startup-policy-proof.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
} catch (error) {
  const message = (error instanceof Error ? error.message : "Scenario failed without a message")
    .replaceAll(typeof connection?.password === "string" ? connection.password : "\u0000", "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 400);
  try { await writeFile(join(evidence, "startup-policy-failure.json"), `${JSON.stringify({ phase, code: String(error?.code ?? error?.name ?? "SCENARIO_FAILURE").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80), message })}\n`, { flag: "wx" }); } catch { /* preserve primary failure */ }
  throw error;
} finally {
  try { await secondPool.end(); } finally { await firstPool.end(); }
}

