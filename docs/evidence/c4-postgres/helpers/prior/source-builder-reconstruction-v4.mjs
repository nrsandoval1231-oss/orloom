import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const sourceValue = process.env.C4_PG_SOURCE;
const configValue = process.env.C4_PG_CONFIG;
const evidenceValue = process.env.C4_PG_EVIDENCE;
if (!sourceValue || !configValue || !evidenceValue) throw new Error("runner paths are incomplete");
const source = resolve(sourceValue);
const configPath = resolve(configValue);
const evidence = resolve(evidenceValue);
const fixtureRoot = resolve(process.env.C4_PG_RUNTIME ?? dirname(evidence));
const expectedSha = process.env.C4_PG_EXPECTED_SHA ?? "";
if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("missing frozen candidate binding");
const evidenceRelative = relative(fixtureRoot, evidence);
if (!evidenceRelative || evidenceRelative.startsWith(`..${sep}`) || evidenceRelative === "..") throw new Error("evidence directory must be beneath the dedicated runtime root");
await mkdir(join(fixtureRoot, "fixtures"), { recursive: true });

const config = JSON.parse(await readFile(configPath, "utf8"));
const load = (relativePath) => import(pathToFileURL(join(source, "dist", relativePath)).href);
const pgNamespace = await import(pathToFileURL(join(source, "node_modules", "pg", "lib", "index.js")).href);
const Pool = pgNamespace.default?.Pool;
if (typeof Pool !== "function") throw new Error("pg default export is not a Pool constructor");
const { SqlMissionStore } = await load("packages/contracts/src/sql-mission-store.js");
const { BareGitFastForwardIntegrator } = await load("packages/integration/src/local.js");
const { TrustedCheckCoordinator, MissionGovernor } = await load("packages/governor/src/governor.js");
const { canonicalJson } = await load("packages/judgment/src/canonical.js");
const { receiptDigestV1 } = await load("packages/contracts/src/verification.js");

const execFile = promisify(execFileCallback);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const results = [];
let currentScenario = "startup";
const note = async (name, detail = {}) => {
  const row = { at: new Date().toISOString(), name, ...detail };
  results.push(row);
  await appendFile(join(evidence, "scenario.jsonl"), `${JSON.stringify(row)}\n`);
};
const sql = (pool) => ({
  query: (text, params) => pool.query(text, params),
  transaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work({ query: (text, params) => client.query(text, params) });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* retain the original transaction error */ }
      throw error;
    } finally {
      client.release();
    }
  }
});
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

const pool = new Pool({ ...config, max: 8, application_name: "c4-local-proof" });
let reconnectPool;
const policyDigest = sha("c4-local-policy-v1");
const receiptArtifact = (label) => ({ key: `sha256/${sha(label)}`, sha256: sha(label), bytes: Buffer.byteLength(label) });
const stdoutArtifact = receiptArtifact("controlled stdout");
const stderrArtifact = receiptArtifact("controlled stderr");
const manifestArtifact = receiptArtifact("controlled input manifest");

function makeTrustedServices(store, candidateSha) {
  const runner = {
    prepareBundle: async () => ({ digest: sha("controlled-bundle"), manifest: Buffer.from("controlled manifest"), files: new Map() }),
    observeHead: async () => ({ sha: candidateSha, observedAt: new Date().toISOString(), digest: sha(`head:${candidateSha}`) }),
    run: async (request) => {
      const started = new Date();
      const body = {
        version: "orloom.trusted-check-receipt.v1", request, verifierId: "c4-controlled-fixture-verifier",
        runtime: "runsc", sandboxId: "c4-controlled-fixture", outcome: "pass", exitCode: 0,
        startedAt: started.toISOString(), finishedAt: new Date(started.getTime() + 1).toISOString(),
        stdout: stdoutArtifact, stderr: stderrArtifact, inputManifest: manifestArtifact
      };
      return { ...body, receiptDigest: receiptDigestV1(body) };
    },
    verifyArtifacts: async () => ({ stdout: Buffer.from("controlled stdout"), stderr: Buffer.from("controlled stderr"), manifest: Buffer.from("controlled input manifest") })
  };
  const make = (missionStore) => {
    const coordinator = new TrustedCheckCoordinator(missionStore, runner, {
      imageDigest: sha("controlled-verifier-image"), verifierId: "c4-controlled-fixture-verifier",
      policyDigest, leasePolicyDigest: policyDigest, policyVersion: "c4-controlled-fixture-policy-v1",
      allowedChecks: ["node-repo-suite-v1"], attemptLifetimeMs: 60_000
    });
    const governor = new MissionGovernor(missionStore, {
      maxLanes: 2, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: policyDigest,
      trustedCheckPolicy: ["node-repo-suite-v1"], executionConfigured: true
    });
    return { coordinator, governor };
  };
  return { ...make(store), make };
}

async function createFixture(store, name) {
  currentScenario = name;
  await store.configureCapacity(1, sha(`c4-capacity-fixture:${name}`), new Date(Date.now() + 120_000).toISOString());
  const caseRoot = join(fixtureRoot, "fixtures", name);
  const repository = join(caseRoot, "source");
  const bare = join(caseRoot, "repository.git");
  const emptyTemplate = join(caseRoot, "empty-template");
  await mkdir(caseRoot, { recursive: false });
  await mkdir(emptyTemplate);
  await git(caseRoot, ["init", "-q", "-b", "main", repository]);
  await git(repository, ["config", "user.name", "C4 controlled fixture"]);
  await git(repository, ["config", "user.email", "c4-fixture@example.invalid"]);
  await writeFile(join(repository, "src.txt"), "base\n");
  await git(repository, ["add", "src.txt"]);
  await git(repository, ["commit", "-qm", "base fixture"]);
  const baseSha = await git(repository, ["rev-parse", "HEAD"]);
  await git(caseRoot, ["clone", "-q", "--bare", `--template=${emptyTemplate}`, repository, bare]);
  await git(bare, ["update-ref", "refs/heads/orloom-integration", baseSha]);
  await writeFile(join(repository, "src.txt"), "candidate\n");
  await git(repository, ["commit", "-qam", "candidate fixture"]);
  const candidateSha = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["push", "-q", bare, `${candidateSha}:refs/heads/candidate`]);
  await git(repository, ["reset", "--hard", baseSha]);
  await writeFile(join(repository, "third.txt"), "unexpected integration ref\n");
  await git(repository, ["add", "third.txt"]);
  await git(repository, ["commit", "-qm", "unexpected third ref"]);
  const thirdSha = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["push", "-q", bare, `${thirdSha}:refs/heads/unexpected-third`]);
  const repositoryIdentity = `owner/c4-${name}`;
  const integrator = await BareGitFastForwardIntegrator.open(bare, repositoryIdentity);
  const inspected = await integrator.inspect({ expectedRefSha: baseSha, candidateSha, scopes: ["src.txt"] });
  const mission = await store.submit({
    repository: repositoryIdentity, baseSha, objective: `C4 PostgreSQL ${name}`,
    acceptance: ["integrate the exact certified candidate"], budgetCents: 20
  });
  await store.recommendPlan(mission.id, [
    { id: "parent", objective: "integrate exact candidate", dependencies: [], owner: "builder", scopes: ["src.txt"], checks: ["node-repo-suite-v1"], budgetCents: 10 },
    { id: "child", objective: "release only after parent integration", dependencies: ["parent"], owner: "builder-2", scopes: ["docs.txt"], checks: ["node-repo-suite-v1"], budgetCents: 10 }
  ], "controlled C4 proof fixture");
  await store.approvePlan(mission.id);
  const grant = await store.claim(300, policyDigest);
  assert(grant, "fixture mission should receive a trusted capacity lease");
  assert.equal(grant.mission.id, mission.id, "lease must belong to this fixture mission");
  assert.equal(grant.slice.id, "parent", "lease must claim this fixture's parent, never a prior scenario's child");
  await store.complete(mission.id, "parent", grant.epoch, grant.leaseToken, grant.capabilityToken, candidateSha, []);
  const reviewPath = join(caseRoot, "retained-review.fixture.json");
  const reviewBytes = Buffer.from(canonicalJson({
    version: "orloom.independent-review.v1", verdict: "PASS", candidateSha,
    treeSha: inspected.treeSha, reviewer: "controlled-independent-review-fixture",
    builder: "builder", scopes: ["src.txt"]
  }));
  await writeFile(reviewPath, reviewBytes, { flag: "wx" });
  const request = {
    version: "orloom.integration-request.v1", missionId: mission.id, sliceId: "parent",
    expectedIntegrationSha: baseSha, candidateSha, leaseEpoch: grant.epoch,
    requiredCheckIds: ["node-repo-suite-v1"], reviewArtifactId: "review-fixture-1",
    reviewArtifactDigest: sha(reviewBytes)
  };
  const integrationMetrics = { successfulCas: 0 };
  const authority = {
    integrator: {
      repositoryIdentity: integrator.repositoryIdentity,
      inspect: (request) => integrator.inspect(request),
      readRef: () => integrator.readRef(),
      compareAndSwap: async (request) => {
        const before = await integrator.readRef();
        const result = await integrator.compareAndSwap(request);
        const after = await integrator.readRef();
        if (before === request.expectedRefSha && after === request.candidateSha) integrationMetrics.successfulCas++;
        return result;
      }
    },
    reviews: { read: async (id) => id === request.reviewArtifactId ? readFile(reviewPath) : null }
  };
  const trusted = makeTrustedServices(store, candidateSha);
  await trusted.coordinator.verifySlice(mission.id, "parent");
  return { caseRoot, bare, baseSha, candidateSha, thirdSha, inspected, mission, request, authority, integrationMetrics, ...trusted };
}

async function assertPending(store, fixture) {
  assert.equal((await store.getIntegrationIntent(fixture.request))?.state, "pending");
  const mission = await store.getMission(fixture.mission.id);
  assert.equal(mission.slices.find((slice) => slice.id === "parent")?.status, "awaiting_verification");
  assert.equal(mission.slices.find((slice) => slice.id === "child")?.status, "waiting_dependency");
}
async function assertNoFinalization(store, fixture) {
  const mission = await store.getMission(fixture.mission.id);
  assert.equal(mission.slices.find((slice) => slice.id === "parent")?.status, "awaiting_verification");
  assert.equal(mission.slices.find((slice) => slice.id === "child")?.status, "waiting_dependency");
  assert.equal((await store.events(fixture.mission.id, 0)).filter((event) => event.type === "slice.integrated").length, 0);
}
async function retireReadyFixtureChild(store, fixture) {
  currentScenario = `${fixture.caseRoot.split(/[\\/]/).at(-1)}-retire-child`;
  const grant = await store.claim(300, policyDigest);
  assert(grant, "released fixture child should be available for a bounded retirement lease");
  assert.equal(grant.mission.id, fixture.mission.id, "retirement lease must stay within the just-completed fixture");
  assert.equal(grant.slice.id, "child", "retirement lease must target only the observed released child");
  await store.complete(fixture.mission.id, "child", grant.epoch, grant.leaseToken, grant.capabilityToken, fixture.candidateSha, []);
  const child = (await store.getMission(fixture.mission.id)).slices.find((slice) => slice.id === "child");
  assert.equal(child?.status, "awaiting_verification", "fixture retirement leaves no synthetic verified outcome");
  await note("fixture_ready_child_retired_without_verification", { child: "awaiting_verification", trustedVerification: "not attempted" });
}
async function leavePendingAfterCas(fixture, store = new SqlMissionStore(sql(pool)), services = fixture) {
  let reads = 0;
  const interrupted = {
    integrator: fixture.authority.integrator,
    reviews: { read: async (id) => {
      if (++reads === 2) throw new Error("controlled interruption after CAS");
      return fixture.authority.reviews.read(id);
    } }
  };
  await assert.rejects(services.governor.integrateVerifiedSlice(fixture.request, services.coordinator, interrupted), /controlled interruption after CAS/);
  assert.equal(await fixture.authority.integrator.readRef(), fixture.candidateSha);
  await assertPending(store, fixture);
}

async function runPositive(store) {
  currentScenario = "ordinary-positive";
  const fixture = await createFixture(store, "ordinary-positive");
  const integrated = await fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority);
  assert.equal(integrated.status, "verified");
  assert.equal(await fixture.authority.integrator.readRef(), fixture.candidateSha);
  const mission = await store.getMission(fixture.mission.id);
  assert.equal(mission.slices.find((slice) => slice.id === "child")?.status, "ready");
  assert.equal((await store.events(fixture.mission.id, 0)).filter((event) => event.type === "slice.integrated").length, 1);
  await note("ordinary_exact_integration", { slice: "verified", child: "ready", integratedEvents: 1 });
  await retireReadyFixtureChild(store, fixture);
}

async function runReconnectDuplicate(store) {
  currentScenario = "post-cas-reconnect-duplicates";
  const fixture = await createFixture(store, "post-cas-reconnect-duplicates");
  await leavePendingAfterCas(fixture, store);
  assert.equal(fixture.integrationMetrics.successfulCas, 1, "the interrupted first request recorded one actual ref advance");
  reconnectPool = new Pool({ ...config, max: 6, application_name: "c4-local-proof-reconnect" });
  const reconnectedStore = new SqlMissionStore(sql(reconnectPool));
  const services = fixture.make(reconnectedStore);
  const [first, second] = await Promise.all([
    fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority),
    services.governor.integrateVerifiedSlice(fixture.request, services.coordinator, fixture.authority)
  ]);
  assert.equal(first.status, "verified");
  assert.equal(second.status, "verified");
  assert.equal(fixture.integrationMetrics.successfulCas, 1, "one first-call CAS advanced the ref; reconnect duplicates do not repeat it");
  assert.equal((await reconnectedStore.events(fixture.mission.id, 0)).filter((event) => event.type === "slice.integrated").length, 1);
  assert.equal((await reconnectedStore.getMission(fixture.mission.id)).slices.find((slice) => slice.id === "child")?.status, "ready");
  await note("new_pool_store_concurrent_exact_replay", { callers: 2, successfulCas: fixture.integrationMetrics.successfulCas, integratedEvents: 1, child: "ready" });
  await retireReadyFixtureChild(reconnectedStore, fixture);
}

async function runMovedRefUnknown(store) {
  currentScenario = "moved-ref-unknown";
  const fixture = await createFixture(store, "moved-ref-unknown");
  await leavePendingAfterCas(fixture, store);
  await git(fixture.bare, ["update-ref", "refs/heads/orloom-integration", fixture.thirdSha]);
  assert.notEqual(fixture.thirdSha, fixture.candidateSha);
  await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority));
  const intent = await store.getIntegrationIntent(fixture.request);
  assert.equal(intent?.state, "unknown");
  await assertNoFinalization(store, fixture);
  await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, fixture.authority), /UNKNOWN/);
  await assertNoFinalization(store, fixture);
  await note("unexpected_third_ref_marks_unknown_without_retry", { intent: "unknown", slice: "awaiting_verification", child: "waiting_dependency", retry: "rejected" });
}

try {
  const poolCheck = await pool.query("SELECT 1 AS connected");
  assert.equal(poolCheck.rows[0].connected, 1);
  for (const migration of ["001_initial.sql", "002_missions.sql", "003_recovery.sql", "004_verification.sql", "005_learning.sql", "006_integration.sql"]) {
    await pool.query(await readFile(join(source, "db", "migrations", migration), "utf8"));
  }
  const heldOne = await pool.connect();
  const heldTwo = await pool.connect();
  try {
    const backendOne = Number((await heldOne.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const backendTwo = Number((await heldTwo.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    assert.notEqual(backendOne, backendTwo, "pool leases two distinct PostgreSQL backends");
    const count = Number((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='c4-local-proof'")).rows[0].n);
    assert(count >= 2, "multiple PostgreSQL backend connections are live");
    await note("fresh_migrations_and_held_connections", { migrations: 6, backendPidsDistinct: true, observedConnections: count });
  } finally {
    heldOne.release();
    heldTwo.release();
  }

  const store = new SqlMissionStore(sql(pool));
  await runPositive(store);
  await runReconnectDuplicate(store);
  await runMovedRefUnknown(store);

  const requestAttempt = async (fixture) => {
    const q = await pool.query("SELECT a.attempt_id,a.request FROM verification_attempts a WHERE a.mission_id=$1 AND a.slice_id='parent' AND a.purpose='final'", [fixture.mission.id]);
    assert.equal(q.rows.length, 1);
    return { attemptId: q.rows[0].attempt_id, request: q.rows[0].request };
  };
  for (const [name, field, value] of [
    ["final-verifier-image-mutation", "verifierImageDigest", sha("unexpected-verifier-image")],
    ["final-input-bundle-mutation", "inputBundleDigest", sha("unexpected-input-bundle")],
    ["final-policy-version-mutation", "policyVersion", "unexpected-policy-version"]
  ]) {
    currentScenario = name;
    const fixture = await createFixture(store, name);
    await leavePendingAfterCas(fixture, store);
    const captured = await requestAttempt(fixture);
    let reads = 0;
    let injectionCount = 0;
    const raceAuthority = {
      reviews: fixture.authority.reviews,
      integrator: {
        repositoryIdentity: fixture.authority.integrator.repositoryIdentity,
        inspect: (request) => fixture.authority.integrator.inspect(request),
        compareAndSwap: (request) => fixture.authority.integrator.compareAndSwap(request),
        readRef: async () => {
          if (++reads === 4) {
            await pool.query("UPDATE verification_attempts SET request=jsonb_set(request,ARRAY[$2]::text[],to_jsonb($3::text),false) WHERE attempt_id=$1", [captured.attemptId, field, value]);
            injectionCount++;
          }
          return fixture.authority.integrator.readRef();
        }
      }
    };
    await assert.rejects(fixture.governor.integrateVerifiedSlice(fixture.request, fixture.coordinator, raceAuthority));
    assert.equal(injectionCount, 1, "finalization race mutation hook must execute exactly once");
    await assertNoFinalization(store, fixture);
    await pool.query("UPDATE verification_attempts SET request=$2::jsonb WHERE attempt_id=$1", [captured.attemptId, canonicalJson(captured.request)]);
    await assertPending(store, fixture);
    await note(name, { postIntentMutation: field, finalization: "rejected", integratedEvents: 0, parent: "awaiting_verification", child: "waiting_dependency" });
  }

  currentScenario = "final-dependency-mutation";
  const dependencyFixture = await createFixture(store, "final-dependency-mutation");
  await leavePendingAfterCas(dependencyFixture, store);
  let dependencyReads = 0;
  let dependencyInjectionCount = 0;
  const dependencyAuthority = {
    reviews: dependencyFixture.authority.reviews,
    integrator: {
      repositoryIdentity: dependencyFixture.authority.integrator.repositoryIdentity,
      inspect: (request) => dependencyFixture.authority.integrator.inspect(request),
      compareAndSwap: (request) => dependencyFixture.authority.integrator.compareAndSwap(request),
      readRef: async () => {
        if (++dependencyReads === 4) {
          await pool.query("UPDATE mission_slices SET dependencies='[\"child\"]'::jsonb WHERE mission_id=$1 AND id='parent'", [dependencyFixture.mission.id]);
          dependencyInjectionCount++;
        }
        return dependencyFixture.authority.integrator.readRef();
      }
    }
  };
  await assert.rejects(dependencyFixture.governor.integrateVerifiedSlice(dependencyFixture.request, dependencyFixture.coordinator, dependencyAuthority));
  assert.equal(dependencyInjectionCount, 1, "dependency finalization race mutation hook must execute exactly once");
  await assertNoFinalization(store, dependencyFixture);
  await pool.query("UPDATE mission_slices SET dependencies='[]'::jsonb WHERE mission_id=$1 AND id='parent'", [dependencyFixture.mission.id]);
  await assertPending(store, dependencyFixture);
  await note("final-dependency-mutation", { postIntentMutation: "parent dependency becomes nonverified child", finalization: "rejected", integratedEvents: 0, parent: "awaiting_verification", child: "waiting_dependency" });

  const summary = {
    candidateSha: expectedSha,
    executionBoundary: "fresh local PostgreSQL integration proof only",
    receiptAndReviewSource: "controlled fixture data passed through production TrustedCheckCoordinator interfaces",
    assertions: results,
    fixtureRoot,
    limitations: ["No C3 runtime, provider, CI, or authentic independent review claim.", "PostgreSQL is a local disposable cluster; this is not deployment or production acceptance."]
  };
  await writeFile(join(evidence, "scenario-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
} catch (error) {
  const rawMessage = typeof error?.message === "string" ? error.message : "Scenario failed without a message";
  const password = typeof config?.password === "string" ? config.password : "";
  const safeMessage = rawMessage
    .replaceAll(password, password ? "[REDACTED]" : "")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
  const errorCode = String(error?.code ?? error?.name ?? "SCENARIO_FAILURE").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const failure = { scenario: String(currentScenario).slice(0, 120), errorCode, message: safeMessage };
  try {
    let target = join(evidence, "scenario-failure.json");
    try { await writeFile(target, `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx" }); }
    catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
      target = join(evidence, `scenario-failure-${randomUUID()}.json`);
      await writeFile(target, `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx" });
    }
  } catch { /* Preserve and rethrow the original failure even if diagnostics cannot be persisted. */ }
  throw error;
} finally {
  try { if (reconnectPool) await reconnectPool.end(); }
  finally { await pool.end(); }
}
