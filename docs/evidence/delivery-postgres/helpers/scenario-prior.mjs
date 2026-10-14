import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

// Consumes the environment variables emitted by work/c4-postgres-proof/run.mjs.
// It uses the production SqlMissionStore and delivery service against local PG,
// while GitHub, the verifier, review source, and R2 bytes stay controlled fakes.
const source = resolve(process.env.C4_PG_SOURCE ?? "");
const configPath = resolve(process.env.C4_PG_CONFIG ?? "");
const evidence = resolve(process.env.C4_PG_EVIDENCE ?? "");
const runtime = resolve(process.env.C4_PG_RUNTIME ?? dirname(evidence));
const expectedSha = process.env.C4_PG_EXPECTED_SHA ?? "";
if (!process.env.C4_PG_SOURCE || !process.env.C4_PG_CONFIG || !process.env.C4_PG_EVIDENCE) throw new Error("runner paths are incomplete");
if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("missing frozen candidate binding");
const evidenceRelative = relative(runtime, evidence);
if (!evidenceRelative || evidenceRelative === ".." || evidenceRelative.startsWith(`..${sep}`)) throw new Error("evidence directory must be beneath the dedicated runtime root");

const config = JSON.parse(await readFile(configPath, "utf8"));
const sourceLoad = (relativePath) => import(pathToFileURL(join(source, "dist", relativePath)).href);
const pgNamespace = await import(pathToFileURL(join(source, "node_modules", "pg", "lib", "index.js")).href);
const Pool = pgNamespace.default?.Pool;
if (typeof Pool !== "function") throw new Error("pg default export is not a Pool constructor");
const [{ SqlMissionStore }, { BareGitFastForwardIntegrator }, { TrustedCheckCoordinator, MissionGovernor }, { deliverIntegratedCommit }, { canonicalJson }, { receiptDigestV1 }] = await Promise.all([
  sourceLoad("packages/contracts/src/sql-mission-store.js"),
  sourceLoad("packages/integration/src/local.js"),
  sourceLoad("packages/governor/src/governor.js"),
  sourceLoad("packages/integration/src/delivery.js"),
  sourceLoad("packages/judgment/src/canonical.js"),
  sourceLoad("packages/contracts/src/verification.js")
]);

const execFile = promisify(execFileCallback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const policyDigest = digest("delivery-postgres-controlled-policy-v1");
const imageDigest = digest("delivery-postgres-controlled-verifier-image");
const rows = [];
let scenarioName = "startup";
let sequence = 0;
const note = async (name, fields = {}) => {
  const row = { at: new Date().toISOString(), name, ...fields };
  rows.push(row);
  await appendFile(join(evidence, "delivery-scenario.jsonl"), `${JSON.stringify(row)}\n`);
};

function sql(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await work({ query: (text, params) => client.query(text, params) });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original SQL failure */ }
        throw error;
      } finally { client.release(); }
    }
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
    GIT_NO_REPLACE_OBJECTS: "1"
  };
  const result = await execFile("git", ["-c", `core.hooksPath=${noGlobalGitConfig}`, "-c", `core.attributesFile=${noGlobalGitConfig}`, "-c", "core.fsmonitor=false", "-c", "diff.external=", "--no-pager", "-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env
  });
  return result.stdout.trim();
}

const hashArtifact = (bytes) => {
  const sha256 = digest(bytes);
  return { key: `sha256/${sha256}`, sha256, bytes: bytes.byteLength };
};

function barrier(expected) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  return async () => {
    arrivals++;
    if (arrivals === expected) release();
    if (arrivals > expected) throw new Error("controlled barrier received an unexpected caller");
    await gate;
  };
}

function fakeGitHub(fixture, options = {}) {
  const checks = new Map();
  const prs = new Map();
  let nextCheckId = 401;
  let nextPrNumber = 501;
  let checkPosts = 0;
  let prPosts = 0;
  const listChecksBarrier = options.listChecksBarrier;
  const listPrsBarrier = options.listPrsBarrier;
  const checkExternalId = `${fixture.mission.id}:${fixture.sliceId}:${fixture.epoch}:${fixture.candidateSha}`;
  const github = {
    appId: fixture.policy.appId,
    createInstallationToken: async () => { throw new Error("provider token acquisition is forbidden in this fixture"); },
    createCheckRun: async () => { throw new Error("non-delivery Check call is forbidden in this fixture"); },
    async inspectBranch(installationId, repository, ref) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      const shaRef = ref === fixture.policy.baseRef ? "refs/heads/main" : `refs/heads/${ref}`;
      const sha = await git(fixture.bare, ["rev-parse", shaRef]);
      const treeSha = await git(fixture.bare, ["rev-parse", `${shaRef}^{tree}`]);
      return { sha, treeSha };
    },
    async listCheckRuns(installationId, repository, headSha, name, externalId) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      assert.equal(headSha, fixture.candidateSha);
      assert.equal(name, fixture.policy.checkName);
      assert.equal(externalId, checkExternalId);
      await listChecksBarrier?.();
      return [...checks.values()].filter((check) => check.headSha === headSha && check.name === name && check.externalId === externalId);
    },
    async getCheckRun(installationId, repository, id) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      const check = checks.get(id);
      if (!check) throw new Error("controlled Check fixture is absent");
      return options.mismatchCheckGetId ? { ...check, id: id + 1000 } : { ...check };
    },
    async createDeliveryCheck(installationId, repository, headSha, name, externalId, title, summary) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      assert.equal(headSha, fixture.candidateSha);
      assert.match(title, /Orloom/);
      assert.match(summary, /does not execute CI/);
      checkPosts++;
      const check = { id: nextCheckId++, headSha, name, externalId, conclusion: "success", appId: fixture.policy.appId };
      checks.set(check.id, check);
      if (options.checkCreate === "throw_after") throw new Error("controlled response lost after Check create");
      if (options.checkCreate === "throw_before") throw new Error("controlled Check request outcome is ambiguous");
      return { ...check };
    },
    async listPullRequests(installationId, repository, head, base) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      assert.equal(head, fixture.branch);
      assert.equal(base, fixture.policy.baseRef);
      await listPrsBarrier?.();
      return [...prs.values()].filter((pr) => pr.headRef === head && pr.baseRef === base);
    },
    async createDraftPullRequest(installationId, repository, headRef, baseRef, title, body) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      assert.match(title, /^Orloom:/);
      assert.match(body, /Review artifact SHA-256/);
      prPosts++;
      const pr = {
        number: nextPrNumber++, draft: true, state: "open", merged: false,
        headRepository: repository, headRef, headSha: fixture.candidateSha,
        baseRepository: repository, baseRef, baseSha: fixture.policy.baseSha
      };
      prs.set(pr.number, pr);
      if (options.prCreate === "throw_after") throw new Error("controlled response lost after PR create");
      return { ...pr };
    },
    async getPullRequest(installationId, repository, number) {
      assert.equal(installationId, fixture.policy.installationId);
      assert.equal(repository, fixture.policy.repository);
      const pr = prs.get(number);
      if (!pr) throw new Error("controlled PR fixture is absent");
      return options.mismatchPrGetNumber ? { ...pr, number: number + 1000 } : { ...pr };
    }
  };
  if (options.existingCheck) {
    checks.set(81, { id: 81, headSha: fixture.candidateSha, name: fixture.policy.checkName, externalId: checkExternalId, conclusion: "success", appId: fixture.policy.appId });
  }
  return {
    github,
    counts: () => ({ checkPosts, prPosts }),
    stateForRestart: () => ({ checks: [...checks.values()].map((value) => ({ ...value })), prs: [...prs.values()].map((value) => ({ ...value })) }),
    importState: (state) => {
      for (const value of state.checks ?? []) checks.set(value.id, { ...value });
      for (const value of state.prs ?? []) prs.set(value.number, { ...value });
    }
  };
}

async function createFixture(store, name) {
  scenarioName = name;
  const physical = String(++sequence);
  const caseRoot = join(runtime, "f", physical);
  const repositoryPath = join(caseRoot, "s");
  const bare = join(caseRoot, "b");
  const template = join(caseRoot, "t");
  const objectSuffix = ["ff", "a".repeat(38)];
  const maxObjectPathChars = Math.max(
    join(bare, "objects", ...objectSuffix).length,
    join(repositoryPath, ".git", "objects", ...objectSuffix).length
  );
  assert(maxObjectPathChars <= 230, `fixture Git object path budget exceeded (${maxObjectPathChars}/230)`);
  await note("fixture-path-budget", { logicalCase: name, physicalCase: physical, maxObjectPathChars, limitChars: 230 });
  await mkdir(caseRoot, { recursive: false });
  await mkdir(template);
  await git(caseRoot, ["init", "-q", "-b", "main", "s"]);
  await git(repositoryPath, ["config", "user.name", "Controlled delivery proof"]);
  await git(repositoryPath, ["config", "user.email", "delivery-proof@example.invalid"]);
  await writeFile(join(repositoryPath, "source.txt"), "base\n", { flag: "wx" });
  await git(repositoryPath, ["add", "source.txt"]);
  await git(repositoryPath, ["commit", "-qm", "controlled base"]);
  const baseSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const baseTree = await git(repositoryPath, ["rev-parse", "HEAD^{tree}"]);
  await git(caseRoot, ["clone", "-q", "--bare", "--template=t", "s", "b"]);
  await git(repositoryPath, ["write-tree"]);
  await writeFile(join(repositoryPath, "source.txt"), "certified integrated candidate\n");
  await git(repositoryPath, ["commit", "-qam", "controlled candidate"]);
  const candidateSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const treeSha = await git(repositoryPath, ["rev-parse", "HEAD^{tree}"]);
  await git(repositoryPath, ["push", "-q", bare, `${candidateSha}:refs/heads/candidate`]);
  await git(bare, ["update-ref", "refs/heads/orloom-integration", baseSha]);
  const repository = `owner/delivery-${physical}`;
  const integrator = await BareGitFastForwardIntegrator.open(bare, repository);
  await integrator.inspect({ expectedRefSha: baseSha, candidateSha, scopes: ["source.txt"] });

  const mission = await store.submit({ repository, baseSha, objective: `PostgreSQL delivery fixture ${name}`, acceptance: ["deliver exact integrated commit"], budgetCents: 100 });
  const sliceId = "delivery";
  await store.recommendPlan(mission.id, [{ id: sliceId, objective: "verify and deliver", dependencies: [], owner: "builder", scopes: ["source.txt"], checks: ["node-repo-suite-v1"], budgetCents: 100 }], "controlled proof fixture");
  await store.approvePlan(mission.id);
  await store.configureCapacity(1, digest(`capacity:${name}`), new Date(Date.now() + 120_000).toISOString());
  const grant = await store.claim(300, policyDigest);
  assert(grant, "fixture mission receives one controlled verifier lease");
  assert.equal(grant.mission.id, mission.id);
  assert.equal(grant.slice.id, sliceId);
  const evidenceBytes = Buffer.from(`controlled content-addressed slice evidence:${name}`);
  const evidenceRef = `sha256:${digest(evidenceBytes)}`;
  await store.complete(mission.id, sliceId, grant.epoch, grant.leaseToken, grant.capabilityToken, candidateSha, [evidenceRef]);

  const artifactBytes = new Map();
  artifactBytes.set(`sha256/${digest(evidenceBytes)}`, evidenceBytes);
  const stdout = Buffer.from(`controlled stdout:${name}`);
  const stderr = Buffer.from(`controlled stderr:${name}`);
  const manifest = Buffer.from(`controlled input manifest:${name}`);
  for (const bytes of [stdout, stderr, manifest]) artifactBytes.set(`sha256/${digest(bytes)}`, bytes);
  const runner = {
    prepareBundle: async () => ({ digest: digest(`bundle:${name}`), manifest: Buffer.from("controlled bundle"), files: new Map() }),
    observeHead: async () => ({ sha: candidateSha, observedAt: new Date().toISOString(), digest: digest(`head:${candidateSha}`) }),
    run: async (request) => {
      const started = new Date();
      const body = {
        version: "orloom.trusted-check-receipt.v1", request,
        verifierId: "controlled-delivery-proof-verifier", runtime: "runsc", sandboxId: `controlled-${name}`,
        outcome: "pass", exitCode: 0, startedAt: started.toISOString(), finishedAt: new Date(started.getTime() + 1).toISOString(),
        stdout: hashArtifact(stdout), stderr: hashArtifact(stderr), inputManifest: hashArtifact(manifest)
      };
      return { ...body, receiptDigest: receiptDigestV1(body) };
    },
    verifyArtifacts: async () => ({ stdout, stderr, manifest })
  };
  const trusted = new TrustedCheckCoordinator(store, runner, {
    imageDigest, verifierId: "controlled-delivery-proof-verifier", policyDigest, leasePolicyDigest: policyDigest,
    policyVersion: "delivery-proof-policy-v1", allowedChecks: ["node-repo-suite-v1"], attemptLifetimeMs: 60_000
  });
  const governor = new MissionGovernor(store, { maxLanes: 2, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: policyDigest, trustedCheckPolicy: ["node-repo-suite-v1"], executionConfigured: true });
  await trusted.verifySlice(mission.id, sliceId);
  const reviewBytes = Buffer.from(canonicalJson({
    version: "orloom.independent-review.v1", verdict: "PASS", candidateSha, treeSha,
    builder: "builder", reviewer: "controlled-review-fixture", scopes: ["source.txt"]
  }));
  const reviewArtifactId = `review-${name}`;
  const integrationRequest = {
    version: "orloom.integration-request.v1", missionId: mission.id, sliceId,
    expectedIntegrationSha: baseSha, candidateSha, leaseEpoch: grant.epoch,
    requiredCheckIds: ["node-repo-suite-v1"], reviewArtifactId, reviewArtifactDigest: digest(reviewBytes)
  };
  const integrationAuthority = {
    integrator: {
      repositoryIdentity: repository,
      inspect: (input) => integrator.inspect(input),
      readRef: () => integrator.readRef(),
      compareAndSwap: (input) => integrator.compareAndSwap(input)
    },
    reviews: { read: async (id) => id === reviewArtifactId ? reviewBytes : null }
  };
  await governor.integrateVerifiedSlice(integrationRequest, trusted, integrationAuthority);

  const policy = {
    repository, appId: 71, installationId: 91, baseRef: "main", baseSha,
    protectedRefs: ["main", "orloom-integration"], checkIds: ["node-repo-suite-v1"],
    policyVersion: "delivery-proof-policy-v1", policyDigest, imageDigest,
    checkName: "Orloom controlled delivery proof"
  };
  const branch = `orloom/delivery/${mission.id}/${digest(sliceId).slice(0, 12)}`;
  await git(bare, ["update-ref", `refs/heads/${branch}`, candidateSha]);
  const command = {
    version: "orloom.delivery-command.v1", missionId: mission.id, sliceId, leaseEpoch: grant.epoch,
    integratedSha: candidateSha, treeSha, reviewArtifactId, reviewArtifactDigest: digest(reviewBytes),
    idempotencyKey: `delivery-proof-${name}`
  };
  return {
    name, caseRoot, bare, mission, sliceId, epoch: grant.epoch, repository, baseSha, baseTree,
    candidateSha, treeSha, branch, policy, command, integrator, reviewBytes, artifactBytes,
    authorityFor(github) {
      return {
        integrator: { repositoryIdentity: repository, inspect: (input) => integrator.inspect(input), readRef: () => integrator.readRef() },
        reviews: { read: async (id) => id === reviewArtifactId ? reviewBytes : null },
        artifacts: { put: async () => { throw new Error("artifact writes are not used in delivery proof"); }, get: async (key) => {
          const bytes = artifactBytes.get(key);
          if (!bytes) throw new Error("controlled artifact is absent");
          return bytes;
        } },
        github
      };
    }
  };
}

async function deliver(store, fixture, fake) {
  return deliverIntegratedCommit(fixture.command, fixture.policy, fixture.authorityFor(fake.github), store);
}
async function rowFor(pool, fixture, effect) {
  const result = await pool.query("SELECT state,external_id FROM mission_delivery_effects WHERE mission_id=$1 AND slice_id=$2 AND lease_epoch=$3 AND effect=$4", [fixture.mission.id, fixture.sliceId, fixture.epoch, effect]);
  return result.rows[0] ?? null;
}
async function mark(store, fixture, name, fields = {}) {
  const intent = await store.getDeliveryIntent({
    version: "orloom.delivery-request.v1", missionId: fixture.mission.id, sliceId: fixture.sliceId,
    leaseEpoch: fixture.epoch, integratedSha: fixture.candidateSha, treeSha: fixture.treeSha,
    repository: fixture.repository, appId: fixture.policy.appId, installationId: fixture.policy.installationId,
    branch: fixture.branch, baseRef: fixture.policy.baseRef, baseSha: fixture.policy.baseSha,
    checkIds: fixture.policy.checkIds, reviewArtifactId: fixture.command.reviewArtifactId,
    reviewArtifactDigest: fixture.command.reviewArtifactDigest, idempotencyKey: fixture.command.idempotencyKey
  });
  await note(name, { intent: intent?.state ?? null, ...fields });
}

const firstPool = new Pool({ ...config, max: 8, application_name: "delivery-proof-primary" });
const secondPool = new Pool({ ...config, max: 6, application_name: "delivery-proof-independent" });
try {
  assert.equal((await firstPool.query("SELECT 1 AS connected")).rows[0].connected, 1);
  assert.equal((await secondPool.query("SELECT 1 AS connected")).rows[0].connected, 1);
  for (const migration of ["001_initial.sql", "002_missions.sql", "003_recovery.sql", "004_verification.sql", "005_learning.sql", "006_integration.sql", "007_delivery.sql"]) {
    await firstPool.query(await readFile(join(source, "db", "migrations", migration), "utf8"));
  }
  const heldOne = await firstPool.connect();
  const heldTwo = await secondPool.connect();
  try {
    const pidOne = Number((await heldOne.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const pidTwo = Number((await heldTwo.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    assert.notEqual(pidOne, pidTwo, "delivery tests use independent PostgreSQL connections");
    await note("fresh_migrations_and_independent_backends", { migrations: 7, distinctBackendPids: true });
  } finally { heldOne.release(); heldTwo.release(); }

  await mkdir(join(runtime, "f"), { recursive: true });
  const storeOne = new SqlMissionStore(sql(firstPool));
  const storeTwo = new SqlMissionStore(sql(secondPool));

  scenarioName = "concurrent-check-claim";
  {
    const fixture = await createFixture(storeOne, scenarioName);
    const listBarrier = barrier(2);
    const fake = fakeGitHub(fixture, { listChecksBarrier: listBarrier });
    const results = await Promise.allSettled([deliver(storeOne, fixture, fake), deliver(storeTwo, fixture, fake)]);
    assert.equal(fake.counts().checkPosts, 1, "independent pools produce only one Check POST");
    assert.equal((await rowFor(firstPool, fixture, "check"))?.state, "observed");
    assert(results.some((result) => result.status === "fulfilled"), "one caller completes the delivery path");
    await mark(storeOne, fixture, scenarioName, { callers: 2, checkPosts: fake.counts().checkPosts, outcomes: results.map((x) => x.status) });
  }

  scenarioName = "concurrent-pr-claim";
  {
    const fixture = await createFixture(storeOne, scenarioName);
    const listBarrier = barrier(2);
    const fake = fakeGitHub(fixture, { existingCheck: true, listPrsBarrier: listBarrier });
    const results = await Promise.allSettled([deliver(storeOne, fixture, fake), deliver(storeTwo, fixture, fake)]);
    assert.equal(fake.counts().prPosts, 1, "independent pools produce only one draft PR POST");
    assert.equal((await rowFor(firstPool, fixture, "pull_request"))?.state, "observed");
    assert(results.some((result) => result.status === "fulfilled"), "one caller completes the delivery path");
    await mark(storeOne, fixture, scenarioName, { callers: 2, prPosts: fake.counts().prPosts, outcomes: results.map((x) => x.status) });
  }

  scenarioName = "restart-after-check-ambiguous-response";
  {
    const fixture = await createFixture(storeOne, scenarioName);
    const fake = fakeGitHub(fixture, { checkCreate: "throw_after" });
    await assert.rejects(deliver(storeOne, fixture, fake), /Check write or separate Check readback/);
    const recoveryPool = new Pool({ ...config, max: 3, application_name: "delivery-proof-check-restart" });
    try {
      const recoveredStore = new SqlMissionStore(sql(recoveryPool));
      const recovered = fakeGitHub(fixture);
      // Carry the external fake's already-created object across the simulated process boundary.
      recovered.importState(fake.stateForRestart());
      const result = await deliver(recoveredStore, fixture, recovered);
      assert.equal(result.state, "pr_created");
      assert.equal(fake.counts().checkPosts, 1);
      assert.equal(recovered.counts().checkPosts, 0);
      assert.equal(recovered.counts().prPosts, 1);
      await mark(recoveredStore, fixture, scenarioName, { checkPostsAcrossRestart: 1, recoveredState: result.state });
    } finally { await recoveryPool.end(); }
  }

  scenarioName = "restart-after-pr-ambiguous-response";
  {
    const fixture = await createFixture(storeOne, scenarioName);
    const fake = fakeGitHub(fixture, { prCreate: "throw_after" });
    await assert.rejects(deliver(storeOne, fixture, fake), /Draft PR write or separate PR readback/);
    const countsBefore = fake.counts();
    const recoveryPool = new Pool({ ...config, max: 3, application_name: "delivery-proof-pr-restart" });
    try {
      const recoveredStore = new SqlMissionStore(sql(recoveryPool));
      const recovered = fakeGitHub(fixture);
      recovered.importState(fake.stateForRestart());
      const result = await deliver(recoveredStore, fixture, recovered);
      assert.equal(result.state, "pr_created");
      assert.equal(countsBefore.checkPosts, 1);
      assert.equal(countsBefore.prPosts, 1);
      assert.equal(recovered.counts().checkPosts, 0);
      assert.equal(recovered.counts().prPosts, 0);
      await mark(recoveredStore, fixture, scenarioName, { originalPosts: countsBefore, replayPosts: recovered.counts(), recoveredState: result.state });
    } finally { await recoveryPool.end(); }
  }

  scenarioName = "unresolved-absent-check-is-not-retried";
  {
    const fixture = await createFixture(storeOne, scenarioName);
    const fake = fakeGitHub(fixture, { checkCreate: "throw_before" });
    await assert.rejects(deliver(storeOne, fixture, fake), /Check write or separate Check readback/);
    const replay = fakeGitHub(fixture);
    await assert.rejects(deliver(storeTwo, fixture, replay), /prior Check write may have occurred/);
    assert.equal(fake.counts().checkPosts, 1);
    assert.equal(replay.counts().checkPosts, 0);
    assert.equal(replay.counts().prPosts, 0);
    assert.equal((await storeTwo.getDeliveryIntent({
      version: "orloom.delivery-request.v1", missionId: fixture.mission.id, sliceId: fixture.sliceId,
      leaseEpoch: fixture.epoch, integratedSha: fixture.candidateSha, treeSha: fixture.treeSha,
      repository: fixture.repository, appId: fixture.policy.appId, installationId: fixture.policy.installationId,
      branch: fixture.branch, baseRef: fixture.policy.baseRef, baseSha: fixture.policy.baseSha,
      checkIds: fixture.policy.checkIds, reviewArtifactId: fixture.command.reviewArtifactId,
      reviewArtifactDigest: fixture.command.reviewArtifactDigest, idempotencyKey: fixture.command.idempotencyKey
    }))?.state, "unknown");
    await mark(storeTwo, fixture, scenarioName, { firstCheckPosts: 1, replayCheckPosts: 0, prPosts: 0 });
  }

  scenarioName = "exact-check-and-pr-readback-identity";
  for (const options of [{ name: "check-id-mismatch", mismatchCheckGetId: true }, { name: "pr-number-mismatch", mismatchPrGetNumber: true }]) {
    const fixture = await createFixture(storeOne, options.name);
    const fake = fakeGitHub(fixture, options);
    await assert.rejects(deliver(storeOne, fixture, fake));
    const intent = await storeOne.getDeliveryIntent({
      version: "orloom.delivery-request.v1", missionId: fixture.mission.id, sliceId: fixture.sliceId,
      leaseEpoch: fixture.epoch, integratedSha: fixture.candidateSha, treeSha: fixture.treeSha,
      repository: fixture.repository, appId: fixture.policy.appId, installationId: fixture.policy.installationId,
      branch: fixture.branch, baseRef: fixture.policy.baseRef, baseSha: fixture.policy.baseSha,
      checkIds: fixture.policy.checkIds, reviewArtifactId: fixture.command.reviewArtifactId,
      reviewArtifactDigest: fixture.command.reviewArtifactDigest, idempotencyKey: fixture.command.idempotencyKey
    });
    assert.notEqual(intent?.state, "pr_created");
    await mark(storeOne, fixture, `readback-${options.name}`, { state: intent?.state, checkPosts: fake.counts().checkPosts, prPosts: fake.counts().prPosts });
  }

  const summary = {
    candidateSha: expectedSha,
    executionBoundary: "prepared scenario for parent-controlled local PostgreSQL runner; not executed during preparation",
    storeAndPipeline: "production SqlMissionStore and deliverIntegratedCommit; independent PostgreSQL pools",
    controlledBoundaries: ["GitHub API fake", "verifier fixture", "independent-review fixture", "content-addressed R2-like artifact fixture"],
    assertions: rows,
    limitations: [
      "No GitHub App credential, external network, R2, remote upload, or real provider request is used.",
      "Controlled PASS receipt and review fixture data do not establish authentic CI or independent review.",
      "A real PostgreSQL behavior PASS is only a local database evidence class, not full delivery or production acceptance."
    ]
  };
  await writeFile(join(evidence, "delivery-scenario-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
} catch (error) {
  const password = typeof config?.password === "string" ? config.password : "";
  const message = (error instanceof Error ? error.message : "Scenario failed without a message")
    .replaceAll(password, password ? "[REDACTED]" : "")
    .replace(/[\r\n\t]+/g, " ").slice(0, 400);
  const failure = { scenario: scenarioName.slice(0, 120), code: String(error?.code ?? error?.name ?? "SCENARIO_FAILURE").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80), message };
  try { await writeFile(join(evidence, "delivery-scenario-failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx" }); } catch { /* preserve original failure */ }
  throw error;
} finally {
  try { await secondPool.end(); } finally { await firstPool.end(); }
}
