import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCgroupObserver } from './cgroup-observer.mjs';

const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
const SAMPLE_INTERVAL_MS = 250, SAMPLE_MAX_ROWS = 960, SAMPLE_MAX_BYTES = 1_048_576, SAMPLE_MAX_ELAPSED_MS = 240_000;
const need = ['ORLOOM_ACCEPTANCE_CONTROL_ROOT','ORLOOM_ACCEPTANCE_DATABASE_URL_FILE','ORLOOM_ACCEPTANCE_OBJECT_STORE','ORLOOM_ACCEPTANCE_BASE_SHA','ORLOOM_ACCEPTANCE_CANDIDATE_SHA','ORLOOM_ACCEPTANCE_FIXTURES_FILE','ORLOOM_ACCEPTANCE_CAPACITY_EVIDENCE_SHA256','ORLOOM_VERIFIER_IMAGE','ORLOOM_VERIFIER_ID','ORLOOM_VERIFIER_ARTIFACT_ROOT','ORLOOM_ACCEPTANCE_EVIDENCE_DIR','ORLOOM_VERIFIER_LAUNCHER','ORLOOM_ACCEPTANCE_DOCKER_CONFIG'];
for (const key of need) assert.ok(process.env[key], `${key} is required`);
const sourceRoot = path.resolve(process.env.ORLOOM_ACCEPTANCE_CONTROL_ROOT);
assert.ok(path.isAbsolute(sourceRoot), 'runtime payload root must be absolute');
const importBuilt = async relative => import(pathToFileURL(path.join(sourceRoot, 'dist', relative)).href);
const [{ PostgresJobStore }, { SqlMissionStore }, { TrustedCheckCoordinator }, verifier] = await Promise.all([
  importBuilt('packages/contracts/src/postgres-store.js'), importBuilt('packages/contracts/src/sql-mission-store.js'),
  importBuilt('packages/governor/src/governor.js'), importBuilt('apps/verifier/src/index.js'),
]);
const databaseUrl = (await readFile(process.env.ORLOOM_ACCEPTANCE_DATABASE_URL_FILE, 'utf8')).trim();
assert.ok(/^postgres:\/\/mission_app:[a-f0-9]{64}@[0-9.]+:5432\/mission_proof$/.test(databaseUrl), 'root-only database URL file is malformed');
const baseSha = process.env.ORLOOM_ACCEPTANCE_BASE_SHA, sourceCandidate = process.env.ORLOOM_ACCEPTANCE_CANDIDATE_SHA;
assert.match(baseSha, /^[a-f0-9]{40}$/); assert.match(sourceCandidate, /^[a-f0-9]{40}$/);
const image = process.env.ORLOOM_VERIFIER_IMAGE;
const imageDigest = image.match(/^(?:sha256:|.+@sha256:)([a-f0-9]{64})$/)?.[1];
assert.ok(imageDigest, 'image must be pinned by immutable digest or local ID');
assert.match(process.env.ORLOOM_ACCEPTANCE_CAPACITY_EVIDENCE_SHA256, /^[a-f0-9]{64}$/);
const fixtureFile = path.resolve(process.env.ORLOOM_ACCEPTANCE_FIXTURES_FILE);
const fixtureBytes = await readFile(fixtureFile), fixtures = JSON.parse(fixtureBytes);
assert.equal(fixtures.format, 'orloom-c3-suite-acceptance-fixtures-v1'); assert.equal(fixtures.sourceCandidate, sourceCandidate); assert.equal(fixtures.baseSha, baseSha);
assert.equal(path.resolve(fixtures.objectStore), path.resolve(process.env.ORLOOM_ACCEPTANCE_OBJECT_STORE));
for (const item of Object.values(fixtures.fixtures)) { assert.equal(item.parent, sourceCandidate); assert.match(item.commit, /^[a-f0-9]{40}$/); }
const repository = process.env.ORLOOM_ACCEPTANCE_REPOSITORY ?? 'nrsandoval1231-oss/orloom';
const approvedRef = fixtures.approvedRef, objectStore = path.resolve(fixtures.objectStore);
const checks = ['node-repo-suite-v1'], leasePolicyDigest = sha(Buffer.from(JSON.stringify(checks)));
const evidenceRoot = path.resolve(process.env.ORLOOM_ACCEPTANCE_EVIDENCE_DIR);
const out = path.join(evidenceRoot, `suite-${randomUUID()}`);
await mkdir(out, { recursive: false, mode: 0o700 });
const put = (file, bytes) => writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
const git = async (...args) => (await exec('git', ['--git-dir', objectStore, ...args], { windowsHide: true })).stdout.trim();
const imageSettings = verifier.getCheckPolicy(checks[0], image, imageDigest);
let jobs, control, stage = 'configuration';
async function inspectCid(cid) {
  const { stdout } = await exec('/usr/bin/docker', ['--config', process.env.ORLOOM_ACCEPTANCE_DOCKER_CONFIG, '--host', 'unix:///var/run/docker.sock', 'inspect', '--format', '{{json .}}', cid], { windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  const info = JSON.parse(stdout);
  const observed = {
    id: info.Id, name: info.Name, image: info.Config.Image, imageId: info.Image,
    packetLabel: info.Config.Labels?.['orloom.packet'], runLabel: info.Config.Labels?.['orloom.run'], candidateLabel: info.Config.Labels?.['orloom.candidate'], status: info.State.Status, pid: info.State.Pid,
    runtime: info.HostConfig.Runtime, networkMode: info.HostConfig.NetworkMode, memoryBytes: info.HostConfig.Memory,
    memorySwapBytes: info.HostConfig.MemorySwap, nanoCpus: info.HostConfig.NanoCpus, pidsLimit: info.HostConfig.PidsLimit,
    readOnlyRoot: info.HostConfig.ReadonlyRootfs, user: info.Config.User, capDrop: info.HostConfig.CapDrop,
    securityOptions: info.HostConfig.SecurityOpt, tmpfs: info.HostConfig.Tmpfs, mounts: info.Mounts,
  };
  assert.equal(observed.id, cid); assert.equal(observed.packetLabel, 'ORL-C3'); assert.equal(observed.candidateLabel, sourceCandidate);
  assert.equal(observed.image, image); assert.equal(observed.runtime, 'runsc'); assert.equal(observed.networkMode, 'none');
  assert.equal(observed.memoryBytes, 1_073_741_824); assert.equal(observed.memorySwapBytes, 1_073_741_824);
  assert.equal(observed.nanoCpus, 1_000_000_000); assert.equal(observed.pidsLimit, 128);
  assert.equal(observed.readOnlyRoot, true); assert.equal(observed.user, '65532:65532');
  assert.deepEqual(observed.capDrop, ['ALL']); assert.ok(observed.securityOptions.includes('no-new-privileges:true'));
  assert.match(observed.tmpfs?.['/work'] ?? '', /(?:^|,)size=512m(?:,|$)/); assert.match(observed.tmpfs?.['/tmp'] ?? '', /(?:^|,)size=16m(?:,|$)/);
  assert.deepEqual(observed.mounts, []); assert.ok(['created','running','exited'].includes(observed.status));
  return observed;
}
const { exactCgroup, readCgroupSample } = createCgroupObserver({ readFile });
async function connect() {
  jobs = await PostgresJobStore.connect(databaseUrl);
  const store = new SqlMissionStore(jobs);
  const runner = await verifier.createTrustedVerificationRunner({
    ...process.env,
    ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({ [repository]: { objectStore, approvedRef } }),
  });
  assert.ok(runner, 'trusted runner did not initialize');
  const attemptLifetimeMs = verifier.getCheckAttemptLifetimeMs(checks[0]);
  assert.equal(attemptLifetimeMs, 240_000, 'suite attempt lifetime must come from the trusted catalog');
  const coordinator = new TrustedCheckCoordinator(store, runner, { imageDigest, verifierId: process.env.ORLOOM_VERIFIER_ID,
    policyDigest: imageSettings.digest, leasePolicyDigest, policyVersion: imageSettings.version, allowedChecks: checks, attemptLifetimeMs });
  return { store, runner, coordinator };
}
async function prepareMission(control, label, candidate, scope) {
  const mission = await control.store.submit({ repository, baseSha, objective: `C3 real PostgreSQL/runsc proof: ${label}.`, acceptance: ['Persist an exact suite attempt and its artifacts.'], budgetCents: 100 });
  await control.store.recommendPlan(mission.id, [{ id: `suite-${label}`, objective: `Run the fixed full repository suite for ${label}.`, dependencies: [], owner: 'c3-suite-acceptance', scopes: [scope], checks, budgetCents: 10 }], 'c3-suite-acceptance');
  await control.store.approvePlan(mission.id);
  const grant = await control.store.claim(300, leasePolicyDigest); assert.ok(grant, `${label}: PostgreSQL claim unavailable`);
  await control.store.complete(mission.id, grant.slice.id, grant.epoch, grant.leaseToken, grant.capabilityToken, candidate, []);
  return { mission, grant };
}
async function runAndObserve(control, mission, grant, dir, expectedCandidate) {
  let done = false, observed = null, binding = null, nextSampleAt = 0, nextCgroupResolveAt = 0;
  const telemetry = { format: 'orloom-c3-memory-observation-stream-v1', status: 'UNKNOWN', intervalMs: SAMPLE_INTERVAL_MS, maxRows: SAMPLE_MAX_ROWS, maxBytes: SAMPLE_MAX_BYTES, maxElapsedMs: SAMPLE_MAX_ELAPSED_MS, rows: [], bytes: 0, unavailableReason: null };
  const observedAt = Date.now();
  assert.match(expectedCandidate, /^[a-f0-9]{40}$/);
  const execution = control.coordinator.verifySlice(mission.id, grant.slice.id).finally(() => { done = true; });
  while (!done) {
    let record = '';
    try { record = (await readFile('/var/lib/orloom/verifier/state', 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parts = record.split('|');
    if (!observed && parts.length === 5 && parts[0] === 'ORL-C3' && /^[a-f0-9]{64}$/.test(parts[3]) && parts[4] === 'running') {
      try {
        const container = await inspectCid(parts[3]);
        assert.equal(container.name, `/${parts[1]}`); assert.equal(container.runLabel, parts[1]);
        observed = { stateRecord: record, container };
        const cgroup = await exactCgroup(container.id, container.pid);
        if (cgroup) binding = { cid: container.id, runId: parts[1], candidateSha: expectedCandidate, imageDigest, cgroup };
        else telemetry.unavailableReason = 'exact-cgroup-unavailable';
      } catch { /* state can disappear between the read and inspect; keep observing */ }
    }
    const now = Date.now();
    if (observed && !binding && now >= nextCgroupResolveAt) {
      nextCgroupResolveAt = now + SAMPLE_INTERVAL_MS;
      try {
        const refreshed = await inspectCid(observed.container.id);
        assert.equal(refreshed.name, observed.container.name); assert.equal(refreshed.runLabel, observed.container.runLabel);
        observed = { ...observed, container: refreshed };
        const cgroup = await exactCgroup(refreshed.id, refreshed.pid);
        if (cgroup) binding = { cid: refreshed.id, runId: refreshed.runLabel, candidateSha: expectedCandidate, imageDigest, cgroup };
      } catch { telemetry.unavailableReason ??= 'exact-cgroup-unavailable'; }
    }
    if (binding && now >= nextSampleAt && telemetry.rows.length < SAMPLE_MAX_ROWS && now - observedAt <= SAMPLE_MAX_ELAPSED_MS) {
      nextSampleAt = now + SAMPLE_INTERVAL_MS;
      try {
        const row = await readCgroupSample(binding, now - observedAt), bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (telemetry.bytes + bytes <= SAMPLE_MAX_BYTES) { telemetry.rows.push(row); telemetry.bytes += bytes; }
        else telemetry.unavailableReason ??= 'byte-cap-reached';
      } catch { telemetry.unavailableReason ??= 'exact-cgroup-read-failed'; }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await execution;
  telemetry.status = telemetry.rows.length ? 'OBSERVED' : 'UNKNOWN';
  if (telemetry.rows.length === SAMPLE_MAX_ROWS) telemetry.unavailableReason ??= 'row-cap-reached';
  if (Date.now() - observedAt > SAMPLE_MAX_ELAPSED_MS) telemetry.unavailableReason ??= 'time-cap-reached';
  const rows = `${telemetry.rows.map(row => JSON.stringify(row)).join('\n')}${telemetry.rows.length ? '\n' : ''}`;
  assert.ok(Buffer.byteLength(rows) <= SAMPLE_MAX_BYTES, 'telemetry stream exceeds its byte cap');
  const summary = { ...telemetry, rows: undefined };
  await put(path.join(dir, 'cgroup-memory-observations.jsonl'), Buffer.from(rows));
  await put(path.join(dir, 'cgroup-memory-observations-summary.json'), Buffer.from(JSON.stringify(summary)));
  await put(path.join(dir, 'runsc-resource-profile.json'), Buffer.from(JSON.stringify({ observed, measuredPeakMemoryBytes: null, measuredPeakCpu: null, memoryObservation: telemetry.status, memoryObservationRows: telemetry.rows.length }, null, 2)));
  assert.ok(observed, 'no runsc container configuration was observed during the real attempt');
  return { observed, binding };
}
async function saveAttempt(control, mission, grant, label, expectedCandidate, expectedOutcome, certificateExpected) {
  stage = `${label}-real-coordinator-run`;
  const dir = path.join(out, label); await mkdir(dir, { mode: 0o700 });
  const observation = await runAndObserve(control, mission, grant, dir, expectedCandidate);
  const result = await jobs.query('SELECT request,receipt,outcome FROM verification_attempts WHERE mission_id=$1 AND slice_id=$2 AND check_id=$3', [mission.id, grant.slice.id, checks[0]]);
  assert.equal(result.rows.length, 1, `${label}: attempt missing`);
  const row = result.rows[0];
  assert.equal(row.request.candidateSha, expectedCandidate, `${label}: persisted request candidate differs from the intended scenario`);
  assert.equal(row.receipt.sandboxId, observation.observed.container.runLabel, `${label}: persisted receipt sandbox differs from the exact inspected run`);
  await put(path.join(dir, 'request.json'), Buffer.from(JSON.stringify(row.request, null, 2)));
  await put(path.join(dir, 'receipt.json'), Buffer.from(JSON.stringify(row.receipt, null, 2)));
  const artifacts = await control.runner.verifyArtifacts(row.receipt);
  await put(path.join(dir, 'input-manifest.json'), artifacts.manifest);
  await put(path.join(dir, 'stdout.bin'), artifacts.stdout); await put(path.join(dir, 'stderr.bin'), artifacts.stderr);
  assert.equal(row.outcome, expectedOutcome); assert.equal(row.receipt.outcome, expectedOutcome);
  const stdout = artifacts.stdout.toString('utf8'), names = [...stdout.matchAll(/^STAGE ([a-z0-9-]+) START$/gm)].map(m => m[1]);
  for (const name of names) {
    const start = stdout.indexOf(`STAGE ${name} START`), next = stdout.indexOf('\nSTAGE ', start + 1);
    const text = stdout.slice(start, next < 0 ? undefined : next + 1);
    await put(path.join(dir, `${name}.stdout.txt`), Buffer.from(text));
  }
  await put(path.join(dir, 'stage-log-index.json'), Buffer.from(JSON.stringify({ stageNames: names, stderrArtifact: 'stderr.bin', stderrAttribution: 'attempt-wide; trusted runner does not delimit stderr by stage' }, null, 2)));
  const cert = await control.coordinator.getCertificate(mission.id, grant.slice.id, checks[0]);
  assert.equal(Boolean(cert), certificateExpected, `${label}: certificate presence mismatch`);
  if (cert) { assert.equal(cert.scope, 'local-exact-commit'); assert.equal(cert.candidateSha, row.request.candidateSha); await put(path.join(dir, 'certificate.json'), Buffer.from(JSON.stringify(cert, null, 2))); }
  assert.deepEqual(await control.store.awaitingVerification(checks, 100).then(items => items.filter(x => x.missionId === mission.id)), [], `${label}: terminal attempt was redispatched`);
  if (label === 'hanging') {
    let record = ''; try { record = (await readFile('/var/lib/orloom/verifier/state', 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await put(path.join(dir, 'timeout-slot-state.txt'), Buffer.from(record || 'EMPTY\n'));
    let timeoutContainer = null, timeoutCid = null, inspectErrorType = null;
    if (record) {
      const parts = record.split('|');
      assert.equal(parts.length, 5); assert.equal(parts[0], 'ORL-C3');
      assert.match(parts[1], /^orloom-verifier-[a-f0-9-]{1,40}$/); assert.equal(parts[2], image);
      assert.match(parts[3], /^[a-f0-9]{64}$/); assert.equal(parts[4], 'running'); timeoutCid = parts[3];
      assert.equal(parts[1], row.receipt.sandboxId, 'slot run name differs from persisted attempt sandbox ID');
      try { timeoutContainer = await inspectCid(parts[3]); assert.equal(timeoutContainer.name, `/${parts[1]}`); assert.equal(timeoutContainer.runLabel, parts[1]); }
      catch (e) { inspectErrorType = e instanceof Error ? e.name : 'unknown'; }
    }
    await put(path.join(dir, 'timeout-container.json'), Buffer.from(JSON.stringify({ stateRecord: record || null, cid: timeoutCid, container: timeoutContainer, inspectErrorType, observedAfterTimeout: true }, null, 2)));
  }
  await put(path.join(dir, 'attempt-summary.json'), Buffer.from(JSON.stringify({ label, outcome: row.outcome, certificate: Boolean(cert), elapsedMs: Date.parse(row.receipt.finishedAt) - Date.parse(row.receipt.startedAt), requestDigest: sha(Buffer.from(JSON.stringify(row.request))), receiptDigest: row.receipt.receiptDigest, stagedStdoutBytes: artifacts.stdout.length, stagedStderrBytes: artifacts.stderr.length }, null, 2)));
  return { cert, dir };
}
async function waitForVerifierSlotRelease(hangingDir) {
  const lock = '/run/orloom-verifier-lock/slot.lock';
  const { lstat } = await import('node:fs/promises');
  const st = await lstat(lock); assert.ok(st.isFile() && !st.isSymbolicLink(), 'verifier lock path is not a regular file');
  const started = Date.now(), deadline = started + 10_000;
  let released = false, lastExitCode = null;
  while (Date.now() < deadline) {
    try {
      await exec('/usr/bin/flock', ['-n', lock, '/bin/true'], { timeout: 1000, windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
      released = true; lastExitCode = 0; break;
    } catch (error) {
      lastExitCode = Number.isInteger(error.code) ? error.code : null;
      if (lastExitCode !== 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const evidence = { command: ['/usr/bin/flock','-n',lock,'/bin/true'], released, elapsedMs: Date.now() - started, exitCode: lastExitCode, deadlineMs: 10_000, purpose: 'wait outside the suite timeout for prior launcher host flock to release' };
  await put(path.join(hangingDir, 'post-timeout-flock-probe.json'), Buffer.from(JSON.stringify(evidence, null, 2)));
  assert.ok(released, 'prior runsc launcher still owns the host slot after bounded 10s wait');
}
try {
  stage = 'open-postgres-and-suite-policy'; control = await connect();
  const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
  await control.store.configureCapacity(1, process.env.ORLOOM_ACCEPTANCE_CAPACITY_EVIDENCE_SHA256, deadline);
  const backendPids = await Promise.all(Array.from({ length: 4 }, async () => Number((await jobs.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)));
  assert.ok(new Set(backendPids).size >= 2, 'proof did not reach multiple PostgreSQL backends');

  stage = 'positive-candidate-selection';
  await git('update-ref', approvedRef, sourceCandidate);
  const good = await prepareMission(control, 'passing', sourceCandidate, 'c3-proof/passing');
  const positive = await saveAttempt(control, good.mission, good.grant, 'passing', sourceCandidate, 'pass', true);
  stage = 'postgres-and-coordinator-reconnect'; await jobs.close(); control = await connect();
  const afterReconnect = await control.coordinator.getCertificate(good.mission.id, good.grant.slice.id, checks[0]);
  assert.deepEqual(afterReconnect, positive.cert, 'certificate changed or vanished after new PostgreSQL/coordinator instances');
  await put(path.join(positive.dir, 'reconnected-certificate.json'), Buffer.from(JSON.stringify(afterReconnect, null, 2)));
  stage = 'stale-approved-ref-denial'; await git('update-ref', approvedRef, baseSha);
  assert.equal(await control.coordinator.getCertificate(good.mission.id, good.grant.slice.id, checks[0]), null, 'stale ref must hide existing certificate');
  await put(path.join(positive.dir, 'stale-ref-denial.json'), Buffer.from(JSON.stringify({ observedRef: await git('rev-parse', approvedRef), candidateSha: sourceCandidate, certificateHidden: true })));

  const cases = [
    ['hanging', 'unknown', false, 'c3-proof/actual-hang'],
    ['failing', 'fail', false, 'c3-proof/failing-test'],
    ['lockMismatch', 'fail', false, 'c3-proof/lock-mismatch'],
  ];
  for (const [name, outcome, certificate, scope] of cases) {
    stage = `${name}-fixture-ref-selection`; const candidate = fixtures.fixtures[name].commit;
    await git('update-ref', approvedRef, candidate);
    const item = await prepareMission(control, name, candidate, scope);
    const attempt = await saveAttempt(control, item.mission, item.grant, name, candidate, outcome, certificate);
    if (name === 'hanging') await waitForVerifierSlotRelease(attempt.dir);
    if (name === 'failing') {
      let slot = ''; try { slot = (await readFile('/var/lib/orloom/verifier/state', 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      assert.equal(slot, '', 'next guarded launcher did not reconcile the exact timeout CID');
      await put(path.join(out, 'timeout-cid-reconciliation.json'), Buffer.from(JSON.stringify({ completedBy: 'next guarded launcher exact-CID reconciliation', slotCleared: true })));
    }
  }
  const manifestRows = [];
  async function walk(dir, rel = '') { for (const name of (await readdir(dir)).sort()) { const target = path.join(dir, name), s = await import('node:fs/promises').then(m => m.lstat(target)); assert.ok(!s.isSymbolicLink()); if (s.isDirectory()) await walk(target, path.posix.join(rel, name)); else manifestRows.push(`${sha(await readFile(target))}  ${path.posix.join(rel, name)}`); } }
  await walk(out);
  await put(path.join(out, 'evidence-manifest.sha256'), Buffer.from(`${manifestRows.sort().join('\n')}\n`));
  process.stdout.write(`${JSON.stringify({ status: 'PASS', evidenceDir: out, sourceCandidate, imageDigest, policyDigest: imageSettings.digest, checks, fixtureFileSha256: sha(fixtureBytes), postgresBackendPids: backendPids, scenarios: ['pass-reconnect-stale-ref','genuine-test-failure','dependency-lock-mismatch','actual-180s-hang-unknown-no-certificate-no-redispatch'], providerCalls: 0 })}\n`);
} catch (error) {
  const errorType = error instanceof Error ? error.name : 'unknown';
  let frame = null;
  if (error instanceof Error && typeof error.stack === 'string') { const m = /runtime-acceptance\.mjs:(\d+):(\d+)/.exec(error.stack); if (m) frame = { line: Number(m[1]), column: Number(m[2]) }; }
  try { await put(path.join(out, 'proof-failure.json'), Buffer.from(JSON.stringify({ status: 'UNKNOWN', stage, errorType, frame }))); } catch {}
  process.stderr.write(`C3 suite runtime proof stopped at ${stage} (${errorType}); redacted frame is in the attempt evidence.\n`);
  process.exitCode = 1;
} finally { await jobs?.close(); }
