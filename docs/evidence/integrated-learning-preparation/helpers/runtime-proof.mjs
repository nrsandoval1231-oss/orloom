import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { armRequestDeadline, assertPersistedWallTime, assertWallTimeWithinBudget, elapsedMilliseconds, fixtureAttemptWallBudgetSeconds, reviewedFixtureBundle, reviewedSourceHead, verifyFixtureBinding, verifyRuntimePayload } from './proof-guards.mjs';
import { closeResources, closeTrackedControls as closeRegisteredControls } from './resource-cleanup.mjs';
import { restoreCertifiedApprovedRef } from './c3-approved-ref.mjs';

const exec = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const need = ['ORLOOM_C1B_SOURCE_ROOT', 'ORLOOM_C1B_RUNTIME_ROOT', 'ORLOOM_C1B_RUNTIME_PAYLOAD_SHA256', 'ORLOOM_C1B_DATABASE_URL_FILE', 'ORLOOM_C1B_OBJECT_STORE', 'ORLOOM_C1B_FIXTURE_FILE', 'ORLOOM_C1B_FIXTURE_BUNDLE', 'ORLOOM_C1B_CAPACITY_EVIDENCE_SHA256', 'ORLOOM_C1B_EVIDENCE_DIR', 'ORLOOM_VERIFIER_IMAGE', 'ORLOOM_VERIFIER_ID', 'ORLOOM_VERIFIER_ARTIFACT_ROOT', 'ORLOOM_VERIFIER_LAUNCHER', 'ORLOOM_C1B_C3_DATABASE_URL_FILE', 'ORLOOM_C1B_C3_DATABASE_NAME', 'ORLOOM_C1B_C3_OBJECT_STORE', 'ORLOOM_C1B_C3_VERIFIER_ARTIFACT_ROOT', 'ORLOOM_C1B_C3_APPROVED_REF', 'ORLOOM_C1B_C3_REPOSITORY', 'ORLOOM_C1B_C3_MISSION_ID', 'ORLOOM_C1B_C3_SLICE_ID', 'ORLOOM_C1B_C3_CERTIFICATE_ID', 'ORLOOM_C1B_C3_POLICY_DIGEST'];
for (const key of need) assert.ok(process.env[key], `${key} is required`);

const repository = 'fixture/orloom', checkId = 'node-validate-syntax', targetCheckId = checkId;
const reviewedBase = reviewedSourceHead;
const strategyIds = { baseline: 'strategy:baseline', recovery: 'strategy:recovery' };
const sourceRoot = await realpath(process.env.ORLOOM_C1B_SOURCE_ROOT);
assert.equal(await realpath(process.cwd()), sourceRoot, 'run from the pinned C1b source root');
const git = async (...args) => (await exec('git', ['-C', sourceRoot, ...args], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
const sourceHead = await git('rev-parse', 'HEAD');
assert.equal(sourceHead, reviewedSourceHead, 'source HEAD differs from the immutable reviewed source pin');
assert.equal(await git('status', '--porcelain=v1'), '', 'source checkout must be fully clean, including untracked files');
const reviewedDelta = (await git('diff', '--name-only', reviewedBase, 'HEAD')).split('\n').filter(Boolean);
assert.ok(reviewedDelta.every(file => file === 'README.md' || file.startsWith('.agent/') || file.startsWith('docs/')), 'runtime source differs from the reviewed C1b source outside documentation');
await git('diff', '--quiet', 'HEAD');
await git('diff', '--cached', '--quiet');

const runtimeRoot = await realpath(process.env.ORLOOM_C1B_RUNTIME_ROOT);
assert.equal(path.resolve(process.env.ORLOOM_C1B_RUNTIME_ROOT), runtimeRoot, 'runtime payload path must be canonical');
const runtimeIdentity = await verifyRuntimePayload(runtimeRoot, process.env.ORLOOM_C1B_RUNTIME_PAYLOAD_SHA256);

let stage = 'inputs', jobsA, jobsB, controlA, controlB, learningActivation;
const activeControls = new Set();
let overallExpired = false;
let output;
const safeWrite = (file, bytes) => writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
const runtimeError = error => error instanceof Error ? error.name : 'unknown';
const addFailure = (current, next, message) => current ? new AggregateError([current, next], message) : next;

function privateIpv4(host) {
  const n = String(host).split('.').map(Number);
  return n.length === 4 && n.every(x => Number.isInteger(x) && x >= 0 && x <= 255)
    && (n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168));
}
function overlaps(a, b) {
  const within = (parent, candidate) => {
    const rel = path.relative(parent, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  return within(a, b) || within(b, a);
}
function api(control, method, route, { body, cookie, lease, worker = false, origin = true } = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { host: 'c1b-runtime.invalid', ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) };
  if (origin) headers.origin = 'https://c1b-runtime.invalid';
  if (cookie) headers.cookie = cookie;
  if (worker) headers.authorization = `Bearer ${control.config.workerToken}`;
  if (lease) {
    headers.authorization = `Bearer ${lease.capabilityToken}`;
    headers['x-orloom-lease-token'] = lease.leaseToken;
    headers['x-orloom-lease-epoch'] = String(lease.leaseEpoch);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: control.port, method, path: route, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = null;
        if (text) { try { value = JSON.parse(text); } catch { reject(new Error('control response was not JSON')); return; } }
        resolve({ status: res.statusCode, headers: res.headers, value });
      });
    });
    armRequestDeadline(req, 90_000);
    req.on('error', error => reject(error.message.includes('timeout') ? new Error('bounded control API request timeout') : new Error('isolated control API request failed')));
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function startControl(databaseUrl, fixture, { fresh = false } = {}) {
  assert.equal(overallExpired, false, 'overall proof deadline already expired');
  const sourceImport = relative => import(pathToFileURL(path.join(runtimeRoot, 'dist', relative)).href);
  const [{ PostgresJobStore }, { SqlMissionStore }, { TrustedCheckCoordinator, MissionGovernor }, { createControlPlane }, { loadConfig }, verifier, { deterministicRecovery }] = await Promise.all([
    sourceImport('packages/contracts/src/postgres-store.js'), sourceImport('packages/contracts/src/sql-mission-store.js'),
    sourceImport('packages/governor/src/governor.js'), sourceImport('apps/control-plane/src/server.js'), sourceImport('packages/config/src/config.js'),
    sourceImport('apps/verifier/src/index.js'), sourceImport('packages/stuck-resolver/src/recovery.js'),
  ]);
  assert.equal(overallExpired, false, 'overall proof deadline expired during module setup');
  const image = process.env.ORLOOM_VERIFIER_IMAGE;
  const imageDigest = image.match(/^(?:sha256:|.+@sha256:)([a-f0-9]{64})$/)?.[1];
  assert.ok(imageDigest, 'verifier image must be pinned to an immutable digest');
  const checks = [checkId];
  const strategies = {
    [strategyIds.baseline]: { checkId, version: 'c1b-runtime-v1', expectedSignal: 'the fixed syntax check fails before recovery', scopeClasses: ['src'], targetCheckIds: [targetCheckId] },
    [strategyIds.recovery]: { checkId, version: 'c1b-runtime-v1', expectedSignal: 'the same fixed syntax check passes after the approved correction', scopeClasses: ['src'], targetCheckIds: [targetCheckId] },
  };
  const sessionToken = `c1b-owner-${randomBytes(24).toString('hex')}`;
  const workerToken = `c1b-worker-${randomBytes(24).toString('hex')}`;
  const env = {
    ...process.env, ORLOOM_MODE: 'cloud', ORLOOM_DATABASE_URL: databaseUrl, ORLOOM_HOST: 'c1b-runtime.invalid',
    ORLOOM_PUBLIC_ORIGIN: 'https://c1b-runtime.invalid', ORLOOM_SESSION_TOKEN: sessionToken, ORLOOM_WORKER_TOKEN: workerToken,
    ORLOOM_MAX_LANES: '3', ORLOOM_CAPACITY_SLOTS: '3', ORLOOM_CAPACITY_EVIDENCE_VERIFIED: 'true',
    ORLOOM_CAPACITY_EVIDENCE_SHA256: process.env.ORLOOM_C1B_CAPACITY_EVIDENCE_SHA256,
    ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT: new Date(Date.now() + 30 * 60_000).toISOString(),
    ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(checks), ORLOOM_TRUSTED_STRATEGIES_JSON: JSON.stringify(strategies),
    ORLOOM_VERIFICATION_POLICY_VERSION: 'orloom.check-policy.v1', ORLOOM_WORKER_MAX_PROVIDER_CALLS: '1',
    ORLOOM_WORKER_MAX_INPUT_TOKENS: '1', ORLOOM_WORKER_MAX_OUTPUT_TOKENS: '1', ORLOOM_WORKER_MAX_WALL_SECONDS: String(fixtureAttemptWallBudgetSeconds),
    ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON: '["fixture"]', ORLOOM_WORKER_ALLOWED_MODELS_JSON: '["fixture-model"]',
  };
  const config = loadConfig(env);
  const checksPolicy = verifier.getCheckPolicy(checkId, image, imageDigest);
  const runner = await verifier.createTrustedVerificationRunner({ ...env, ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({ [repository]: { objectStore: path.resolve(process.env.ORLOOM_C1B_OBJECT_STORE), approvedRef: fixture.approvedRef } }) });
  assert.ok(runner, 'actual configured trusted runner did not initialize');
  assert.equal(overallExpired, false, 'overall proof deadline expired during runner setup');
  const jobs = await PostgresJobStore.connect(databaseUrl);
  const control = { jobs, server: undefined };
  activeControls.add(control);
  try {
  assert.equal(overallExpired, false, 'overall proof deadline expired during database startup');
  const store = new SqlMissionStore(jobs);
  const coordinator = new TrustedCheckCoordinator(store, runner, {
    imageDigest, verifierId: env.ORLOOM_VERIFIER_ID, policyDigest: checksPolicy.digest,
    leasePolicyDigest: config.trustedCheckPolicyDigest, policyVersion: checksPolicy.version,
    allowedChecks: checks, attemptLifetimeMs: verifier.getCheckAttemptLifetimeMs(checkId),
  });
  const judge = snapshot => deterministicRecovery(snapshot);
  const server = control.server = createControlPlane(config, jobs, store, judge, coordinator, undefined, learningActivation);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.closeAllConnections?.(); reject(new Error('bounded controller listen timeout')); }, 10_000);
    server.once('error', () => { clearTimeout(timer); reject(new Error('isolated controller failed to listen')); });
    server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  Object.assign(control, { config, store, runner, coordinator, port: address.port, governor: new MissionGovernor(store, {
    maxLanes: config.maxLanes, capacitySlots: config.capacitySlots, leaseSeconds: 300,
    trustedCheckPolicyDigest: config.trustedCheckPolicyDigest, recoveryPolicyDigest: config.recoveryPolicyDigest,
    trustedCheckPolicy: config.trustedCheckPolicy, trustedStrategies: config.trustedStrategies,
    executionConfigured: true, progressLimits: { maxProviderCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxWallSeconds: fixtureAttemptWallBudgetSeconds },
  }, judge) });
  control.cookie = await login(control);
  control.checkPolicyDigest = checksPolicy.digest;
  return control;
  } catch (error) {
    try { await closeControl(control); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'controller startup and cleanup failed'); }
    throw error;
  }
}

async function prepareC3Activation(runtimeRoot) {
  const secretPath = path.resolve(process.env.ORLOOM_C1B_C3_DATABASE_URL_FILE);
  const secretHandle = await open(secretPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let databaseUrl;
  try {
    const info = await secretHandle.stat();
    assert.ok(info.isFile() && info.size > 0 && info.size <= 8192, 'C3 database URL must be a bounded regular file');
    assert.equal(info.uid, 0, 'C3 database URL file must be owned by root');
    assert.ok([0o400, 0o600].includes(info.mode & 0o777), 'C3 database URL file must have exact root-only 0400 or 0600 permissions');
    databaseUrl = (await secretHandle.readFile('utf8')).trim();
  } finally { await secretHandle.close(); }
  const parsed = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.equal(parsed.searchParams.has('options'), false, 'C3 database URL may not override the read-only session setting');
  assert.equal(parsed.username, 'mission_app'); assert.equal(parsed.port || '5432', '5432');
  assert.equal(parsed.pathname, `/${process.env.ORLOOM_C1B_C3_DATABASE_NAME}`);
  assert.notEqual(parsed.pathname, '/mission_proof_c1b', 'C3 certificate database must remain separate from C1b proof database');
  assert.ok(privateIpv4(parsed.hostname)); assert.match(decodeURIComponent(parsed.password), /^[a-f0-9]{64}$/);
  assert.ok(path.isAbsolute(process.env.ORLOOM_C1B_C3_OBJECT_STORE));
  assert.ok(path.isAbsolute(process.env.ORLOOM_C1B_C3_VERIFIER_ARTIFACT_ROOT));
  const c3ArtifactRoot = await realpath(process.env.ORLOOM_C1B_C3_VERIFIER_ARTIFACT_ROOT);
  assert.equal(path.resolve(process.env.ORLOOM_C1B_C3_VERIFIER_ARTIFACT_ROOT), c3ArtifactRoot, 'C3 artifact root must be canonical and existing');
  const c3ArtifactInfo = await lstat(c3ArtifactRoot); assert.ok(c3ArtifactInfo.isDirectory() && !c3ArtifactInfo.isSymbolicLink());
  assert.ok(!overlaps(c3ArtifactRoot, path.resolve(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT))
    && !overlaps(c3ArtifactRoot, path.resolve(process.env.ORLOOM_C1B_OBJECT_STORE))
    && !overlaps(c3ArtifactRoot, path.resolve(process.env.ORLOOM_C1B_C3_OBJECT_STORE))
    && !overlaps(c3ArtifactRoot, sourceRoot), 'C3, C1b, source, and object-store roots must stay separate');
  const c3ObjectStore = path.resolve(process.env.ORLOOM_C1B_C3_OBJECT_STORE);
  assert.ok(!overlaps(c3ObjectStore, path.resolve(process.env.ORLOOM_C1B_OBJECT_STORE))
    && !overlaps(c3ObjectStore, path.resolve(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT))
    && !overlaps(c3ObjectStore, sourceRoot), 'C3 object store must be separate from C1b/source roots');
  assert.ok(/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(process.env.ORLOOM_C1B_C3_APPROVED_REF));
  assert.match(process.env.ORLOOM_C1B_C3_MISSION_ID, /^[0-9a-f-]{36}$/i);
  assert.match(process.env.ORLOOM_C1B_C3_SLICE_ID, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.match(process.env.ORLOOM_C1B_C3_CERTIFICATE_ID, /^[0-9a-f-]{36}$/i);
  assert.match(process.env.ORLOOM_C1B_C3_POLICY_DIGEST, /^[a-f0-9]{64}$/);

  // Read-only query surface: the accepted C3 pool runs in a read-only transaction mode,
  // and the coordinator's certificate path calls only getCertificate/getMission queries.
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl, options: '-c default_transaction_read_only=on', max: 2, connectionTimeoutMillis: 5000 });
  pool.on('error', () => {});
  const c3Control = { jobs: { close: () => pool.end() }, server: undefined };
  activeControls.add(c3Control);
  try {
    const dbIdentity = await pool.query('SELECT current_database() AS database, current_user AS user_name, current_setting(\'transaction_read_only\') AS read_only');
    assert.deepEqual(dbIdentity.rows[0], { database: process.env.ORLOOM_C1B_C3_DATABASE_NAME, user_name: 'mission_app', read_only: 'on' });
    const c3Store = new (await import(pathToFileURL(path.join(runtimeRoot, 'dist/packages/contracts/src/sql-mission-store.js')).href)).SqlMissionStore({
      query: async (text, params) => await pool.query(text, params),
    });
    const sourceImport = relative => import(pathToFileURL(path.join(runtimeRoot, 'dist', relative)).href);
    const [{ TrustedCheckCoordinator }, { CertifiedLearningActivation }, { loadConfig }, verifier] = await Promise.all([
      sourceImport('packages/governor/src/governor.js'), sourceImport('packages/learning/src/activation.js'),
      sourceImport('packages/config/src/config.js'), sourceImport('apps/verifier/src/index.js'),
    ]);
    const image = process.env.ORLOOM_VERIFIER_IMAGE;
    const imageDigest = image.match(/^(?:sha256:|.+@sha256:)([a-f0-9]{64})$/)?.[1];
    assert.ok(imageDigest, 'C3 verifier image must be pinned to an immutable digest');
    const checkId = 'node-repo-suite-v1';
    const env = { ...process.env, ORLOOM_MODE: 'cloud', ORLOOM_DATABASE_URL: databaseUrl,
      ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify([checkId]) };
    const config = loadConfig(env), policy = verifier.getCheckPolicy(checkId, image, imageDigest);
    const runner = await verifier.createTrustedVerificationRunner({ ...env, ORLOOM_VERIFIER_ARTIFACT_ROOT: c3ArtifactRoot, ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({
      [process.env.ORLOOM_C1B_C3_REPOSITORY]: { objectStore: path.resolve(process.env.ORLOOM_C1B_C3_OBJECT_STORE), approvedRef: process.env.ORLOOM_C1B_C3_APPROVED_REF },
    }) });
    assert.ok(runner, 'actual C3 trusted runner did not initialize');
    const coordinator = new TrustedCheckCoordinator(c3Store, runner, {
      imageDigest, verifierId: process.env.ORLOOM_VERIFIER_ID, policyDigest: policy.digest,
      leasePolicyDigest: config.trustedCheckPolicyDigest, policyVersion: policy.version,
      allowedChecks: [checkId], attemptLifetimeMs: verifier.getCheckAttemptLifetimeMs(checkId),
    });
    const runtimeSha = reviewedSourceHead;
    const binding = { missionId: process.env.ORLOOM_C1B_C3_MISSION_ID, sliceId: process.env.ORLOOM_C1B_C3_SLICE_ID,
      runtimeSha, certificateId: process.env.ORLOOM_C1B_C3_CERTIFICATE_ID, policyDigest: process.env.ORLOOM_C1B_C3_POLICY_DIGEST };
    const activation = new CertifiedLearningActivation(coordinator, binding);
    if (process.env.ORLOOM_C1B_C3_RESTORE_EXPECTED_NEGATIVE_SHA) {
      await restoreCertifiedApprovedRef({ objectStore: process.env.ORLOOM_C1B_C3_OBJECT_STORE,
        approvedRef: process.env.ORLOOM_C1B_C3_APPROVED_REF,
        expectedNegativeSha: process.env.ORLOOM_C1B_C3_RESTORE_EXPECTED_NEGATIVE_SHA,
        certifiedSha: process.env.ORLOOM_C1B_C3_RESTORE_CERTIFIED_SHA,
        binding, activation });
    }
    await activation.assertAccepted();
    return { activation, binding, checkId, c3Control, repository: process.env.ORLOOM_C1B_C3_REPOSITORY,
      approvedRef: process.env.ORLOOM_C1B_C3_APPROVED_REF, databaseName: process.env.ORLOOM_C1B_C3_DATABASE_NAME };
  } catch (error) {
    try { await closeControl(c3Control); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'C3 certificate lookup setup and cleanup failed'); }
    throw error;
  }
}

async function login(control) {
  const response = await api(control, 'POST', '/session', { body: { token: control.config.sessionToken } });
  assert.equal(response.status, 204);
  const values = response.headers['set-cookie'];
  const cookie = Array.isArray(values) ? values[0] : values;
  assert.ok(cookie); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(';', 1)[0];
}
async function closeControl(control) {
  if (!control) return;
  if (control.closePromise) return control.closePromise;
  control.closePromise = (async () => {
    const errors = await closeResources(control);
    if (errors.length) throw new AggregateError(errors, 'bounded control and pool cleanup failed');
    activeControls.delete(control);
  })();
  try { await control.closePromise; }
  finally { control.closePromise = undefined; }
}
async function closeTrackedControls() {
  return closeRegisteredControls(activeControls, closeControl);
}
async function writeEventsManifest() {
  const files = [];
  const visit = async dir => {
    const { readdir, lstat, readFile: read } = await import('node:fs/promises');
    for (const name of await readdir(dir)) {
      if (name === 'evidence-manifest.sha256') continue;
      const target = path.join(dir, name), st = await lstat(target);
      assert.ok(!st.isSymbolicLink());
      if (st.isDirectory()) await visit(target);
      else if (st.isFile()) files.push(`${sha(await read(target))}  ${path.relative(output, target).split(path.sep).join('/')}`);
      else throw new Error('unexpected evidence file type');
    }
  };
  await visit(output);
  await safeWrite(path.join(output, 'evidence-manifest.sha256'), Buffer.from(`${files.sort().join('\n')}\n`));
}

async function main() {
  const source = await readFile(process.env.ORLOOM_C1B_FIXTURE_FILE), fixture = JSON.parse(source);
  assert.equal(fixture.format, 'orloom-c1b-runtime-fixture-v1');
  verifyFixtureBinding(fixture, await readFile(path.resolve(process.env.ORLOOM_C1B_FIXTURE_BUNDLE)));
  assert.equal(fixture.baseSha, reviewedBase);
  assert.equal(fixture.repository, repository); assert.equal(fixture.approvedRef, 'refs/heads/orloom-c1b-runtime-proof');
  assert.equal(fixture.fixturePath, 'scripts/validate.mjs');
  assert.equal(fixture.targetCheckId, targetCheckId); assert.equal(fixture.checkId, checkId);
  assert.deepEqual(Object.keys(fixture.commits).sort(), ['episodeAFail', 'episodeAPass', 'episodeBFail', 'episodeBPass', 'laterFail'].sort());
  assert.ok(Object.values(fixture.commits).every(value => /^[a-f0-9]{40}$/.test(value)));
  assert.ok(path.isAbsolute(process.env.ORLOOM_C1B_OBJECT_STORE));
  const objectStore = path.resolve(process.env.ORLOOM_C1B_OBJECT_STORE), bundlePath = path.resolve(process.env.ORLOOM_C1B_FIXTURE_BUNDLE);
  assert.equal(await realpath(objectStore), objectStore, 'object store path must be canonical and existing');
  assert.equal(sha(await readFile(bundlePath)), reviewedFixtureBundle, 'transported fixture bundle digest mismatch');
  const objectType = await exec('git', ['--git-dir', objectStore, 'rev-parse', '--is-bare-repository'], { windowsHide: true });
  assert.equal(objectType.stdout.trim(), 'true');
  assert.equal((await exec('git', ['--git-dir', objectStore, 'rev-parse', fixture.approvedRef], { windowsHide: true })).stdout.trim(), fixture.commits.laterFail);
  const sequence = [fixture.commits.episodeAFail, fixture.commits.episodeAPass, fixture.commits.episodeBFail, fixture.commits.episodeBPass, fixture.commits.laterFail];
  let expectedParent = fixture.baseSha;
  for (const shaValue of sequence) {
    assert.equal((await exec('git', ['--git-dir', objectStore, 'cat-file', '-t', shaValue], { windowsHide: true })).stdout.trim(), 'commit');
    const parents = (await exec('git', ['--git-dir', objectStore, 'rev-list', '--parents', '-n', '1', shaValue], { windowsHide: true })).stdout.trim().split(/\s+/);
    assert.deepEqual(parents, [shaValue, expectedParent], 'fixture commits must form the reviewed linear parent chain');
    const changed = (await exec('git', ['--git-dir', objectStore, 'diff-tree', '--no-commit-id', '--name-only', '-r', shaValue], { windowsHide: true })).stdout.trim().split(/\r?\n/);
    assert.deepEqual(changed, ['scripts/validate.mjs'], 'fixture commit changes unexpected paths');
    expectedParent = shaValue;
  }
  assert.match(process.env.ORLOOM_C1B_CAPACITY_EVIDENCE_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(typeof process.getuid, 'function', 'root-owned database secret requires POSIX identity checks');
  const secretPath = path.resolve(process.env.ORLOOM_C1B_DATABASE_URL_FILE);
  const secretHandle = await open(secretPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let databaseUrl;
  try {
    const secretInfo = await secretHandle.stat();
    assert.ok(secretInfo.isFile(), 'database URL input must be a regular file');
    assert.ok(secretInfo.size > 0 && secretInfo.size <= 8192, 'database URL file size is outside the accepted bound');
    assert.equal(secretInfo.uid, 0, 'database URL file must be owned by root');
    assert.ok([0o400, 0o600].includes(secretInfo.mode & 0o777), 'database URL file must have exact root-only 0400 or 0600 permissions');
    databaseUrl = (await secretHandle.readFile('utf8')).trim();
  } finally { await secretHandle.close(); }
  const parsedDb = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsedDb.protocol));
  assert.equal(parsedDb.username, 'mission_app'); assert.equal(parsedDb.port || '5432', '5432');
  assert.equal(parsedDb.pathname, '/mission_proof_c1b'); assert.ok(privateIpv4(parsedDb.hostname));
  assert.match(decodeURIComponent(parsedDb.password), /^[a-f0-9]{64}$/);
  assert.ok(path.isAbsolute(process.env.ORLOOM_C1B_EVIDENCE_DIR));
  assert.ok(path.isAbsolute(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT));
  const root = await realpath(process.env.ORLOOM_C1B_EVIDENCE_DIR);
  const artifactRoot = await realpath(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT);
  assert.equal(path.resolve(process.env.ORLOOM_C1B_EVIDENCE_DIR), root, 'evidence root path must be canonical');
  assert.equal(path.resolve(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT), artifactRoot, 'artifact root path must be canonical');
  const rootInfo = await lstat(root); assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  assert.ok(!overlaps(root, sourceRoot) && !overlaps(root, objectStore) && !overlaps(root, artifactRoot), 'evidence root must be separate from source, object and artifact roots');
  assert.ok(!overlaps(artifactRoot, sourceRoot) && !overlaps(artifactRoot, objectStore), 'artifact root must be separate from source and object-store roots');
  output = path.join(root, `c1b-${randomUUID()}`); await mkdir(output, { recursive: false, mode: 0o700 });
  const c3 = await prepareC3Activation(runtimeRoot); learningActivation = c3.activation;
  await safeWrite(path.join(output, 'c3-activation-binding.json'), Buffer.from(JSON.stringify({
    sourceHead, runtimeSha: c3.binding.runtimeSha, missionId: c3.binding.missionId, sliceId: c3.binding.sliceId,
    checkId: c3.checkId, certificateId: c3.binding.certificateId, policyDigest: c3.binding.policyDigest,
    databaseName: c3.databaseName, repository: c3.repository, approvedRef: c3.approvedRef,
    lookup: 'actual C3 TrustedCheckCoordinator.getCertificate against read-only retained database and approved-ref repository map',
  }, null, 2)));
  await safeWrite(path.join(output, 'fixture.json'), source);
  await safeWrite(path.join(output, 'source-identity.json'), Buffer.from(JSON.stringify({ sourceHead, reviewedBase, fixtureBundleSha256: fixture.bundleSha256, runtimePayloadManifestSha256: runtimeIdentity.payloadManifestSha256, runtime: 'real-postgresql-actual-trusted-runner-runsc', providerCalls: 0 }, null, 2)));

  // Confirm the target DB is genuinely fresh before the production startup loader runs.
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const { Pool } = require('pg');
  const preflightPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const dbIdentity = await preflightPool.query('SELECT current_database() AS database, current_user AS user_name');
    assert.deepEqual(dbIdentity.rows[0], { database: 'mission_proof_c1b', user_name: 'mission_app' });
    const tables = await preflightPool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.equal(tables.rows.length, 0, 'runtime database must be fresh and disposable');
  } finally { await preflightPool.end(); }

  stage = 'fresh-migration-and-runtime-bootstrap';
  const initial = await startControl(databaseUrl, fixture); controlA = initial; jobsA = initial.jobs;
  const migrations = (await jobsA.query('SELECT version FROM orloom_schema_migrations ORDER BY version')).rows.map(row => String(row.version));
  assert.deepEqual(migrations, ['001_initial', '002_missions', '003_recovery', '004_verification', '005_learning']);
  await safeWrite(path.join(output, 'fresh-startup-migrations.json'), Buffer.from(JSON.stringify({ database: 'mission_proof_c1b', versions: migrations, loader: 'PostgresJobStore.connect' }, null, 2)));
  await initial.store.configureCapacity(3, process.env.ORLOOM_C1B_CAPACITY_EVIDENCE_SHA256, new Date(Date.now() + 30 * 60_000).toISOString());
  const second = await startControl(databaseUrl, fixture); controlB = second; jobsB = second.jobs;
  const pids = await Promise.all([initial.jobs.query('SELECT pg_backend_pid() AS pid,pg_sleep(0.2)'), second.jobs.query('SELECT pg_backend_pid() AS pid,pg_sleep(0.2)')]);
  const backendPids = pids.map(r => Number(r.rows[0].pid));
  assert.notEqual(backendPids[0], backendPids[1], 'race fixtures must use separate PostgreSQL pools/backends');
  await safeWrite(path.join(output, 'separate-backends.json'), Buffer.from(JSON.stringify({ backendPids, poolCount: 2, simultaneousQueries: true }, null, 2)));

  const run = async (control, lease, ordinal, strategyId, candidateSha, expectedOutcome, label) => {
    stage = `${label}-trusted-runsc-attempt`;
    const startedAt = new Date().toISOString();
    const startedMonotonic = performance.now();
    await exec('git', ['--git-dir', objectStore, 'update-ref', fixture.approvedRef, candidateSha], { windowsHide: true });
    const response = await api(control, 'POST', `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/recovery-check`, {
      body: { candidateSha, targetCheckId, strategyId, ordinal }, lease, origin: false,
    });
    assert.equal(response.status, 200);
    assert.equal(response.value.outcome, expectedOutcome);
    const query = await control.jobs.query('SELECT request,receipt,outcome,request_digest,target_check_id,strategy_id,recovery_ordinal,head_observed_at,head_observation_digest FROM verification_attempts WHERE attempt_id=$1 AND purpose=$2', [response.value.attemptId, 'recovery']);
    assert.equal(query.rows.length, 1);
    const row = query.rows[0], receipt = row.receipt;
    assert.equal(row.outcome, expectedOutcome); assert.equal(receipt.outcome, expectedOutcome);
    assert.equal(receipt.runtime, 'runsc'); assert.match(receipt.sandboxId, /^orloom-verifier-[a-f0-9-]+$/);
    assert.equal(receipt.exitCode, expectedOutcome === 'pass' ? 0 : 1);
    assert.equal(row.request.candidateSha, candidateSha); assert.equal(row.request.expectedLocalHeadSha, candidateSha);
    assert.equal(row.target_check_id, targetCheckId); assert.equal(row.strategy_id, strategyId); assert.equal(Number(row.recovery_ordinal), ordinal);
    const artifacts = await control.runner.verifyArtifacts(receipt);
    const manifest = JSON.parse(artifacts.manifest.toString('utf8'));
    assert.equal(manifest.version, 'orloom.input-manifest.v1'); assert.equal(manifest.candidateSha, candidateSha);
    const syntaxEntry = manifest.files.find(item => item.path === fixture.fixturePath);
    assert.ok(syntaxEntry, 'trusted input manifest omitted the exact syntax-check script');
    const script = await exec('git', ['--git-dir', objectStore, 'cat-file', 'blob', `${candidateSha}:${fixture.fixturePath}`], { encoding: 'buffer', windowsHide: true });
    assert.equal(syntaxEntry.sha256, sha(script.stdout)); assert.equal(syntaxEntry.bytes, script.stdout.length);
    if (expectedOutcome === 'fail') assert.match(artifacts.stderr.toString('utf8'), /SyntaxError/);
    else { assert.equal(artifacts.stdout.length, 0); assert.equal(artifacts.stderr.length, 0); }
    const finishedMonotonic = performance.now();
    const finishedAt = new Date().toISOString();
    const elapsedWallMs = elapsedMilliseconds(startedMonotonic, finishedMonotonic);
    assertWallTimeWithinBudget(elapsedWallMs, fixtureAttemptWallBudgetSeconds);
    const dirname = path.join(output, label); await mkdir(dirname, { recursive: false, mode: 0o700 });
    await safeWrite(path.join(dirname, 'request.json'), Buffer.from(JSON.stringify(row.request, null, 2)));
    await safeWrite(path.join(dirname, 'receipt.json'), Buffer.from(JSON.stringify(receipt, null, 2)));
    await safeWrite(path.join(dirname, 'stdout.bin'), artifacts.stdout); await safeWrite(path.join(dirname, 'stderr.bin'), artifacts.stderr);
    await safeWrite(path.join(dirname, 'input-manifest.json'), artifacts.manifest);
    await safeWrite(path.join(dirname, 'attempt-summary.json'), Buffer.from(JSON.stringify({ label, attemptId: response.value.attemptId, outcome: row.outcome, candidateSha, checkId, targetCheckId, strategyId, ordinal, startedAt, finishedAt, startedMonotonicMs: startedMonotonic, finishedMonotonicMs: finishedMonotonic, elapsedWallMs, configuredWallBudgetSeconds: fixtureAttemptWallBudgetSeconds, receiptDigest: receipt.receiptDigest, requestDigest: row.request_digest, exitCode: receipt.exitCode, runtime: receipt.runtime, sandboxId: receipt.sandboxId, artifactRefs: { stdout: receipt.stdout, stderr: receipt.stderr, manifest: receipt.inputManifest }, policyDigest: row.request.policyDigest, planDigest: row.request.planDigest, headObservedAt: row.head_observed_at, headObservationDigest: row.head_observation_digest, argv: ['/usr/local/bin/node', '--check', 'scripts/validate.mjs'], stdoutSha256: sha(artifacts.stdout), stderrSha256: sha(artifacts.stderr), manifestSha256: sha(artifacts.manifest) }, null, 2)));
    return { attemptId: response.value.attemptId, receiptDigest: receipt.receiptDigest, requestDigest: row.request_digest, outcome: row.outcome, startedAt, finishedAt, elapsedWallMs };
  };
  const claim = async control => {
    const result = await api(control, 'POST', '/api/worker/claim', { body: {}, worker: true, origin: false });
    assert.equal(result.status, 200); return result.value;
  };
  const progress = async (control, lease, policy, attempt, ordinal, strategyId, candidateSha, status) => {
    const event = { version: 'orloom.progress.v2', eventId: `c1b-${randomUUID()}`, missionId: lease.mission.id, sliceId: lease.slice.id,
      leaseEpoch: lease.leaseEpoch, ordinal, planDigest: policy.planDigest, trustedCheckPolicyDigest: policy.trustedCheckPolicyDigest,
      recoveryPolicyDigest: policy.recoveryPolicyDigest, phase: 'trusted_check', status, reasonCode: status === 'failed' ? 'check_failed' : 'check_passed',
      strategyId, targetCheckId, checkId, counters: { providerCalls: 0, inputTokens: 0, outputTokens: 0, wallMs: attempt.elapsedWallMs },
      evidenceRefs: [`sha256:${attempt.receiptDigest}`], trustedAttemptId: attempt.attemptId, candidateSha };
    const result = await api(control, 'POST', `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/progress`, { body: event, lease, origin: false });
    assert.equal(result.status, 200);
    const persisted = await control.jobs.query('SELECT progress FROM mission_recovery_progress WHERE event_id=$1', [event.eventId]);
    assert.equal(persisted.rows.length, 1);
    assertPersistedWallTime(persisted.rows[0].progress, attempt.elapsedWallMs);
    assertWallTimeWithinBudget(attempt.elapsedWallMs, fixtureAttemptWallBudgetSeconds);
    await safeWrite(path.join(output, `decision-${ordinal}-${event.eventId}.json`), Buffer.from(JSON.stringify({ progress: event, snapshot: result.value.snapshot, action: result.value.action, judgment: result.value.judgment }, null, 2)));
    return result.value;
  };
  const createMission = async (control, label, sliceIds) => {
    const created = await api(control, 'POST', '/api/missions', { cookie: control.cookie, body: { repository, baseSha: fixture.baseSha, objective: `C1b trusted runtime proof ${label}`, acceptance: ['real runner FAIL/PASS/contradiction follows the immutable lesson binding'], budgetCents: 900 } });
    assert.equal(created.status, 201);
    const slices = sliceIds.map(id => ({ id, objective: `Isolated recovery episode ${id}`, dependencies: [], owner: 'c1b-runtime-proof', scopes: [`src/c1b-runtime/${id}`], checks: [strategyIds.baseline, strategyIds.recovery], budgetCents: 100 }));
    assert.equal((await api(control, 'POST', `/api/missions/${created.value.id}/plan`, { cookie: control.cookie, body: { recommendedBy: 'c1b-runtime-proof', slices } })).status, 201);
    assert.equal((await api(control, 'POST', `/api/missions/${created.value.id}/approve`, { cookie: control.cookie, body: {} })).status, 200);
    return created.value.id;
  };
  const policyFor = async (control, lease) => {
    const result = await api(control, 'GET', `/api/worker/missions/${lease.mission.id}/slices/${lease.slice.id}/recovery-policy`, { lease, origin: false });
    assert.equal(result.status, 200); return result.value;
  };
  const executeEpisode = async (control, lease, label, failSha, passSha) => {
    const policy = await policyFor(control, lease);
    const failedAttempt = await run(control, lease, 1, strategyIds.baseline, failSha, 'fail', `${label}-baseline-fail`);
    const failedDecision = await progress(control, lease, policy, failedAttempt, 1, strategyIds.baseline, failSha, 'failed');
    assert.equal(failedDecision.action.action, 'change_strategy'); assert.equal(failedDecision.action.strategyId, strategyIds.recovery);
    const passedAttempt = await run(control, lease, 2, failedDecision.action.strategyId, passSha, 'pass', `${label}-approved-recovery-pass`);
    const passedDecision = await progress(control, lease, policy, passedAttempt, 2, strategyIds.recovery, passSha, 'passed');
    assert.equal(passedDecision.action.action, 'continue');
    return { failedAttempt, passedAttempt, failedDecision, passedDecision };
  };

  stage = 'two-real-postgres-runsc-episodes';
  const sourceMission = await createMission(initial, 'two comparable episodes', ['episode-a', 'episode-b']);
  const episodeEvidence = [];
  for (const [index, id] of ['episode-a', 'episode-b'].entries()) {
    const lease = await claim(initial); assert.equal(lease.mission.id, sourceMission); assert.equal(lease.slice.id, id);
    const result = index === 0
      ? await executeEpisode(initial, lease, 'episode-a', fixture.commits.episodeAFail, fixture.commits.episodeAPass)
      : await executeEpisode(initial, lease, 'episode-b', fixture.commits.episodeBFail, fixture.commits.episodeBPass);
    episodeEvidence.push({ sliceId: id, ...result });
  }
  const lessons = await api(initial, 'GET', `/api/missions/${sourceMission}/lessons`, { cookie: initial.cookie });
  assert.equal(lessons.status, 200);
  const candidate = lessons.value.find(row => row.status === 'candidate'); assert.ok(candidate, 'real trusted attempt pairs did not produce a candidate');
  assert.equal(candidate.repository, repository); assert.equal(candidate.fromCheckId, targetCheckId); assert.equal(candidate.strategyId, strategyIds.recovery);
  assert.deepEqual(candidate.baseline, { failed: 2, observed: 2 }); assert.deepEqual(candidate.outcome, { passed: 2, observed: 2 });
  await safeWrite(path.join(output, 'candidate.json'), Buffer.from(JSON.stringify(candidate, null, 2)));

  stage = 'independent-challenge-concurrent-replay';
  const route = `/api/lessons/${candidate.id}/challenge`;
  const challengeRace = await Promise.all([api(initial, 'POST', route, { cookie: initial.cookie, body: {} }), api(second, 'POST', route, { cookie: second.cookie, body: {} })]);
  assert.ok(challengeRace.every(r => r.status === 200 && r.value.decision === 'accepted'));
  assert.equal(challengeRace[0].value.attestationDigest, challengeRace[1].value.attestationDigest, 'concurrent challenge replay must be immutable/idempotent');
  const originalChallenge = challengeRace[0].value;
  await safeWrite(path.join(output, 'challenge-replay.json'), Buffer.from(JSON.stringify({ candidateId: candidate.id, replayCount: challengeRace.length, replayAttestationDigests: challengeRace.map(x => x.value.attestationDigest), decision: originalChallenge.decision, verifierId: originalChallenge.verifierId, evidenceDigest: originalChallenge.evidenceDigest, challengerAlgorithmVersion: originalChallenge.algorithmVersion }, null, 2)));

  stage = 'controller-and-postgres-restart-before-promotion';
  await closeControl(controlA); await closeControl(controlB); controlA = undefined; controlB = undefined; jobsA = undefined; jobsB = undefined;
  const third = await startControl(databaseUrl, fixture); controlA = third; jobsA = third.jobs;
  const fourth = await startControl(databaseUrl, fixture); controlB = fourth; jobsB = fourth.jobs;
  const durableChallenges = await third.jobs.query("SELECT lesson_id,lesson_version,decision,challenge_digest FROM operational_lesson_challenges WHERE lesson_id=$1 ORDER BY lesson_version", [candidate.id]);
  assert.equal(durableChallenges.rows.length, 1); assert.equal(durableChallenges.rows[0].decision, 'accepted');
  await safeWrite(path.join(output, 'durable-challenges.json'), Buffer.from(JSON.stringify(durableChallenges.rows, null, 2)));
  const migrationReload = (await third.jobs.query('SELECT version FROM orloom_schema_migrations ORDER BY version')).rows.map(row => String(row.version));
  assert.deepEqual(migrationReload, migrations, 'fresh and reconnect startup paths must retain the same migration set');

  stage = 'natural-candidate-promotion';
  const naturalPromotion = await api(third, 'POST', `/api/lessons/${candidate.id}/promote`, { cookie: third.cookie, body: { challengeDigest: originalChallenge.attestationDigest } });
  assert.equal(naturalPromotion.status, 200);
  const promoted = await third.store.getLesson(candidate.id);
  assert.equal(promoted?.status, 'promoted', 'the naturally generated and challenged candidate must be the promoted lesson');
  assert.equal(promoted?.challengeDigest, originalChallenge.attestationDigest);
  await safeWrite(path.join(output, 'natural-promotion.json'), Buffer.from(JSON.stringify({ candidateId: candidate.id, promotedLessonId: promoted.id, lessonVersion: promoted.lessonVersion, challengeDigest: promoted.challengeDigest, separatePoolsChallengeReplay: true }, null, 2)));

  stage = 'controller-and-postgres-restart-before-later-selection';
  await closeControl(controlA); await closeControl(controlB); controlA = undefined; controlB = undefined; jobsA = undefined; jobsB = undefined;
  const fifth = await startControl(databaseUrl, fixture); controlA = fifth; jobsA = fifth.jobs;
  const afterRestart = await fifth.store.getLesson(String(promoted.id));
  assert.equal(afterRestart?.status, 'promoted'); assert.equal(afterRestart?.lessonVersion, Number(promoted.lessonVersion));
  assert.equal(afterRestart?.challengeDigest, String(promoted.challengeDigest));

  stage = 'later-authorized-use-and-trusted-contradiction-withdrawal';
  const laterMission = await createMission(fifth, 'later comparable strategy selection', ['later']);
  const laterLease = await claim(fifth); assert.equal(laterLease.mission.id, laterMission);
  const laterPolicy = await policyFor(fifth, laterLease);
  const laterFail = await run(fifth, laterLease, 1, strategyIds.baseline, fixture.commits.laterFail, 'fail', 'later-baseline-fail');
  const laterDecision = await progress(fifth, laterLease, laterPolicy, laterFail, 1, strategyIds.baseline, fixture.commits.laterFail, 'failed');
  assert.deepEqual(laterDecision.snapshot.lessonBindings, [{ id: String(promoted.id), lessonVersion: Number(promoted.lessonVersion), challengeDigest: String(promoted.challengeDigest), policyDigest: candidate.policyDigest, strategyId: strategyIds.recovery }]);
  assert.equal(laterDecision.snapshot.preferredStrategyId, strategyIds.recovery);
  assert.equal(laterDecision.judgment.source, 'deterministic', 'this proof explicitly uses the Governor deterministic fallback, not live Jev');
  assert.equal(laterDecision.action.action, 'change_strategy'); assert.equal(laterDecision.action.strategyId, strategyIds.recovery);
  assert.deepEqual(laterDecision.action.lessonBindings, laterDecision.snapshot.lessonBindings);
  await safeWrite(path.join(output, 'later-selection.json'), Buffer.from(JSON.stringify({ snapshot: laterDecision.snapshot, action: laterDecision.action, judgment: laterDecision.judgment }, null, 2)));
  const contradiction = await run(fifth, laterLease, 2, laterDecision.action.strategyId, fixture.commits.laterFail, 'fail', 'later-trusted-contradiction');
  const lessonBeforeProgress = await fifth.store.getLesson(String(promoted.id));
  assert.equal(lessonBeforeProgress?.status, 'withdrawn', 'the trusted FAIL under the promoted strategy must atomically withdraw the lesson');
  const contradictionDecision = await progress(fifth, laterLease, laterPolicy, contradiction, 2, strategyIds.recovery, fixture.commits.laterFail, 'failed');
  assert.deepEqual(contradictionDecision.snapshot.lessonBindings, [], 'the fresh post-withdrawal decision must omit the lesson');
  const eventEvidence = await fifth.jobs.query("SELECT type,data FROM mission_events WHERE mission_id=$1 AND type IN ('check.recovery_fail','lesson.withdrawn','slice.progress') ORDER BY cursor", [laterMission]);
  await safeWrite(path.join(output, 'withdrawal-events.json'), Buffer.from(JSON.stringify(eventEvidence.rows, null, 2)));
  await safeWrite(path.join(output, 'withdrawal.json'), Buffer.from(JSON.stringify({ lessonId: String(promoted.id), lessonVersion: Number(promoted.lessonVersion), challengeDigest: String(promoted.challengeDigest), contradictionAttemptId: contradiction.attemptId, contradictionReceiptDigest: contradiction.receiptDigest, contradictionCandidateSha: fixture.commits.laterFail, latestLessonStatus: lessonBeforeProgress?.status, freshSnapshotLessonBindings: contradictionDecision.snapshot.lessonBindings, action: contradictionDecision.action }, null, 2)));

  stage = 'separate-synthetic-promotion-contention';
  const syntheticIds = [randomUUID(), randomUUID()];
  for (const [index, id] of syntheticIds.entries()) await fifth.jobs.query(`INSERT INTO operational_lessons(id,repository,cohort,from_check_id,strategy_id,rule,lesson_version,metric,direction,baseline_failed,baseline_observed,outcome_passed,outcome_observed,policy_version,policy_digest,status,evidence_event_ids,challenge_digest,proposed_by)
    SELECT $1,repository,cohort,from_check_id,strategy_id,rule,lesson_version+$3,metric,direction,baseline_failed,baseline_observed,outcome_passed,outcome_observed,policy_version,policy_digest,'candidate',evidence_event_ids,challenge_digest,'c1b-separate-contention-fixture'
    FROM operational_lessons WHERE id=$2 AND status='withdrawn'`, [id, candidate.id, index + 20]);
  controlB = await startControl(databaseUrl, fixture); jobsB = controlB.jobs;
  const syntheticChallenges = await Promise.all(syntheticIds.map((id, i) => api(i ? controlB : fifth, 'POST', `/api/lessons/${id}/challenge`, { cookie: i ? controlB.cookie : fifth.cookie, body: {} })));
  assert.ok(syntheticChallenges.every(r => r.status === 200 && r.value.decision === 'accepted'));
  const syntheticPromotions = await Promise.all(syntheticIds.map((id, i) => api(i ? controlB : fifth, 'POST', `/api/lessons/${id}/promote`, { cookie: i ? controlB.cookie : fifth.cookie, body: { challengeDigest: syntheticChallenges[i].value.attestationDigest } })));
  assert.equal(syntheticPromotions.filter(r => r.status === 200).length, 1);
  assert.equal(syntheticPromotions.filter(r => r.status === 409).length, 1);
  await safeWrite(path.join(output, 'synthetic-contention.json'), Buffer.from(JSON.stringify({ syntheticCandidateIds: syntheticIds, positiveCandidateId: candidate.id, positiveNaturalCandidateAlreadyWithdrawn: (await fifth.store.getLesson(candidate.id))?.status === 'withdrawn', challengeDigests: syntheticChallenges.map(r => r.value.attestationDigest), promotionStatuses: syntheticPromotions.map(r => r.status), independentPostgresPools: true }, null, 2)));

  stage = 'evidence-finalization';
  finalSummary = { sourceHead, reviewedBase, fixtureBundleSha256: reviewedFixtureBundle, fixtureBaseSha: fixture.baseSha, fixtureCommits: fixture.commits,
    migration005: 'fresh startup and controller/pool reconnect', independentChallenge: 'actual runner re-read persisted canonical receipt and content-addressed artifacts',
    challengeReplay: 'same attestation digest across two controller/pool instances', syntheticContention: 'separate synthetic candidates; cannot substitute for positive-path candidate',
    wallTime: 'each persisted wallMs equals the observed monotonic trusted-attempt interval recorded with start/finish timestamps; finite 300-second attempt budget',
    laterUse: 'deterministic Governor fallback; exact promoted ID/version/challenge digest in snapshot and Governor action', contradiction: 'real trusted FAIL under recovery strategy; durable withdrawal; fresh snapshot omits lesson',
    checkId, targetCheckId, policyDigest: fifth.config.trustedCheckPolicyDigest, recoveryPolicyDigest: fifth.config.recoveryPolicyDigest,
    capacityEvidenceSha256: process.env.ORLOOM_C1B_CAPACITY_EVIDENCE_SHA256, database: 'mission_proof_c1b', providerCalls: 0,
    scope: 'disposable real PostgreSQL plus actual TrustedVerificationRunner, durable artifact store, fixed syntax policy and existing LocalRunscLauncher; no live provider/host deployment', candidateId: candidate.id, promotedLessonId: String(promoted.id), withdrawn: true };
}

let finalSummary, runError;
const running = main().catch(error => { runError = addFailure(runError, error, 'runtime proof failed after an earlier failure'); });
let overallTimer, timedOut = false, settledAfterTimeout = true;
try {
  const result = await Promise.race([running.then(() => 'finished'), new Promise(resolve => { overallTimer = setTimeout(() => resolve('timeout'), 15 * 60_000); })]);
  if (result === 'timeout') {
    timedOut = true; overallExpired = true; runError ??= new Error('overall runtime proof window expired');
    for (const error of await closeTrackedControls()) runError = addFailure(runError, error, 'overall timeout and controller cleanup failed');
    controlA = undefined; controlB = undefined; jobsA = undefined; jobsB = undefined;
    let settleTimer;
    const settled = await Promise.race([running.then(() => true), new Promise(resolve => { settleTimer = setTimeout(() => resolve(false), 100_000); })]);
    clearTimeout(settleTimer);
    settledAfterTimeout = settled;
    if (!settled) runError = addFailure(runError, new Error('runtime did not settle after bounded shutdown'), 'runtime timeout did not settle');
  }
}
finally {
  clearTimeout(overallTimer);
  const closeErrors = await closeTrackedControls();
  if (closeErrors.length) runError = addFailure(runError, new AggregateError(closeErrors, 'controller or postgres pool shutdown failed'), 'proof and cleanup failed');
}
if (!runError && finalSummary) {
  await safeWrite(path.join(output, 'summary.json'), Buffer.from(JSON.stringify({ status: 'BEHAVIOR_PASS_PENDING_CONTROLLER_CLEANUP', runtimePayloadManifestSha256: runtimeIdentity.payloadManifestSha256, ...finalSummary }, null, 2)));
  await writeEventsManifest();
  process.stdout.write(JSON.stringify({ status: 'BEHAVIOR_PASS_PENDING_CONTROLLER_CLEANUP', evidenceDir: output, sourceHead: reviewedSourceHead, runtimePayloadManifestSha256: runtimeIdentity.payloadManifestSha256, candidate: finalSummary.candidateId, promotedLessonId: finalSummary.promotedLessonId, withdrawn: true, providerCalls: 0 }) + '\n');
} else {
  const record = { status: 'UNKNOWN', stage, errorType: runtimeError(runError), sourceHead: reviewedSourceHead,
    note: 'Raw error details are withheld because database URLs, tokens, or host paths may be sensitive; controller cleanup/postflight is separate.' };
  if (output) await writeFile(path.join(output, 'proof-failure.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  const line = `C1b runtime acceptance UNKNOWN at ${stage} (${record.errorType}); see retained proof evidence if present.\n`;
  if (activeControls.size > 0 || (timedOut && !settledAfterTimeout)) await new Promise(resolve => process.stderr.write(line, resolve)).then(() => process.exit(1));
  process.stderr.write(line); process.exitCode = 1;
}
