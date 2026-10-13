import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { armRequestDeadline, assertPersistedWallTime, assertWallTimeWithinBudget, elapsedMilliseconds, fixtureAttemptWallBudgetSeconds, verifyFixtureBinding, verifyRuntimePayload } from './proof-guards.mjs';
import { closeResources, closeTrackedControls } from './resource-cleanup.mjs';
import { restoreCertifiedApprovedRef } from './c3-approved-ref.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const payload = path.join(root, 'runtime-payload');
const identity = JSON.parse(await readFile(path.join(payload, 'runtime-files-identity.json'), 'utf8'));
const fixtureDir = path.join(root, 'prepared-fixture-8f271de-deterministic');
const fixture = JSON.parse(await readFile(path.join(fixtureDir, 'fixture.json'), 'utf8'));
verifyFixtureBinding(fixture, await readFile(path.join(fixtureDir, 'fixture.bundle')));
await assert.rejects(async () => verifyFixtureBinding(fixture, Buffer.from('altered fixture')), error => error?.code === 'ERR_ASSERTION');
await assert.rejects(async () => verifyFixtureBinding({ ...fixture, commits: { ...fixture.commits, laterFail: '0'.repeat(40) } }, await readFile(path.join(fixtureDir, 'fixture.bundle'))), error => error?.code === 'ERR_ASSERTION');
const measuredStart = performance.now(); await new Promise(resolve => setTimeout(resolve, 5)); const measuredFinish = performance.now();
const measuredWallMs = elapsedMilliseconds(measuredStart, measuredFinish);
assertWallTimeWithinBudget(measuredWallMs, fixtureAttemptWallBudgetSeconds);
const persistedProgress = JSON.parse(JSON.stringify({ counters: { wallMs: measuredWallMs } }));
assertPersistedWallTime(persistedProgress, measuredWallMs);
assert.throws(() => assertPersistedWallTime({ counters: { wallMs: measuredWallMs + 1 } }, measuredWallMs), /differs from the measured/i);
assert.throws(() => assertWallTimeWithinBudget(fixtureAttemptWallBudgetSeconds * 1000 + 1, fixtureAttemptWallBudgetSeconds), /exceeded/i);

const temp = await mkdtemp(path.join(root, '.guard-check-'));
try {
  const tampered = path.join(temp, 'payload');
  await cp(payload, tampered, { recursive: true });
  await verifyRuntimePayload(tampered, identity.payloadManifestSha256);
  const manifest = (await readFile(path.join(tampered, 'runtime-files.sha256'), 'utf8')).trimEnd().split('\n');
  const relative = manifest[0].split('  ')[1];
  await writeFile(path.join(tampered, ...relative.split('/')), 'stale compiled bytes');
  await assert.rejects(() => verifyRuntimePayload(tampered, identity.payloadManifestSha256), /hash mismatch/i);
} finally { await rm(temp, { recursive: true, force: true }); }

const { CertifiedLearningActivation } = await import(new URL('./runtime-payload/dist/packages/learning/src/activation.js', import.meta.url));
const noCertificate = new CertifiedLearningActivation({ getCertificate: async (...args) => {
  assert.deepEqual(args, ['bound-mission', 'bound-slice', 'node-repo-suite-v1']); return null;
} }, { missionId: 'bound-mission', sliceId: 'bound-slice', runtimeSha: fixture.sourceHead, certificateId: 'certificate', policyDigest: 'a'.repeat(64) });
await assert.rejects(() => noCertificate.assertAccepted(), /unavailable/);

const casRoot = await mkdtemp(path.join(root, '.cas-check-'));
try {
  const casStore = path.join(casRoot, 'fixture.git');
  await cp(path.join(fixtureDir, 'fixture.git'), casStore, { recursive: true });
  const runGit = async (...args) => (await promisify(execFile)('git', args, { windowsHide: true })).stdout.trim();
  const current = fixture.commits.laterFail, target = fixture.sourceHead;
  let rechecked = 0;
  const binding = { runtimeSha: target }, activation = { async assertAccepted() { rechecked++; } };
  await assert.rejects(() => restoreCertifiedApprovedRef({ objectStore: casStore, approvedRef: fixture.approvedRef,
    expectedNegativeSha: fixture.commits.episodeAFail, certifiedSha: target, binding, activation }), /moved since/);
  assert.equal(await runGit('--git-dir', casStore, 'rev-parse', fixture.approvedRef), current);
  const restored = await restoreCertifiedApprovedRef({ objectStore: casStore, approvedRef: fixture.approvedRef,
    expectedNegativeSha: current, certifiedSha: target, binding, activation });
  assert.equal(restored.certificateRequeried, true); assert.equal(rechecked, 1);
  assert.equal(await runGit('--git-dir', casStore, 'rev-parse', fixture.approvedRef), target);
} finally { await rm(casRoot, { recursive: true, force: true }); }

const server = http.createServer((_req, _res) => {});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
try {
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const result = await new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: address.port, path: '/' });
    armRequestDeadline(request, 40);
    request.on('error', error => resolve(error.message)); request.end();
  });
  assert.equal(result, 'bounded request timeout');
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

let failedCloseForced = false, failedClosePoolAttempted = false;
const closeErrors = await closeResources({
  server: { listening: true, close(callback) { callback(new Error('injected close failure')); }, closeAllConnections() { failedCloseForced = true; } },
  jobs: { close() { failedClosePoolAttempted = true; return Promise.resolve(); } },
}, 30);
assert.ok(closeErrors.length > 0); assert.equal(failedCloseForced, true); assert.equal(failedClosePoolAttempted, true);

const childModule = new URL('./resource-cleanup.mjs', import.meta.url).href;
const childCode = `import {closeResources,closeTrackedControls} from ${JSON.stringify(childModule)}; let forced=false,pool=false; const resources={server:{listening:true,close(_cb){},closeAllConnections(){forced=true}},jobs:{close(){pool=true;return Promise.resolve()}}}; const controls=new Set([resources]); const errors=await closeTrackedControls(controls,async c=>{const e=await closeResources(c,30);if(e.length)throw new AggregateError(e);controls.delete(c)}); const status=errors.length||controls.size?'UNKNOWN':'PASS'; console.log(JSON.stringify({status,forced,pool,errors:errors.length,stillTracked:controls.size})); process.exitCode=status==='UNKNOWN'?1:0;`;
let child;
try { child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childCode], { windowsHide: true, timeout: 2000 }); }
catch (error) { child = error; }
assert.equal(child.code, 1); assert.deepEqual(JSON.parse(child.stdout.trim()), { status: 'UNKNOWN', forced: true, pool: true, errors: 1, stillTracked: 1 });

process.stdout.write(JSON.stringify({ status: 'LOCAL_GUARDS_PASS', alteredFixtureRejected: true, staleCompiledPayloadRejectedBeforeImport: true, stalledLoopbackHttpRejected: true, failedCloseStillClosesPool: true, stalledServerExitsUnknown: true, measuredWallCounterRoundTrip: true, missingC3CertificateFailsClosed: true, approvedRefRestoreIsCASAndRequeries: true, providers: 0 }) + '\n');
