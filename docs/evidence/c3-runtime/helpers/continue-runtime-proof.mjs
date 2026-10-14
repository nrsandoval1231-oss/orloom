import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgresJobStore } from '../orloom-ci/dist/packages/contracts/src/postgres-store.js';
import { SqlMissionStore } from '../orloom-ci/dist/packages/contracts/src/sql-mission-store.js';
import { TrustedCheckCoordinator } from '../orloom-ci/dist/packages/governor/src/governor.js';
import { createTrustedVerificationRunner, getCheckPolicy } from '../orloom-ci/dist/apps/verifier/src/index.js';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedCid = '140edd29f054bc9897d8f66a8b6b3bc90054954b8ff19996a31dd3fc6198dce4';
const expectedRun = 'orloom-verifier-6f0f96cf-f4ab-4fc9-86c4-62a6bdb1f13d';
const expectedMissionObjective = 'Exercise exact-CID sandbox interruption recovery without retrying the same attempt.';
const required = ['ORLOOM_PROOF_DATABASE_URL_FILE', 'ORLOOM_PROOF_OBJECT_STORE', 'ORLOOM_PROOF_BASE_SHA', 'ORLOOM_PROOF_CANDIDATE_SHA', 'ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256', 'ORLOOM_PROOF_DOCKER_CONFIG', 'ORLOOM_VERIFIER_IMAGE', 'ORLOOM_VERIFIER_ID', 'ORLOOM_VERIFIER_ARTIFACT_ROOT', 'ORLOOM_PROOF_EVIDENCE_DIR', 'ORLOOM_PROOF_STALE_CONFIG'];
for (const name of required) assert.ok(process.env[name], `${name} is required`);
const databaseUrl = (await readFile(process.env.ORLOOM_PROOF_DATABASE_URL_FILE, 'utf8')).trim();
assert.ok(/^postgres:\/\/mission_app:[a-f0-9]{64}@[0-9.]+:5432\/mission_proof$/.test(databaseUrl), 'database URL format is invalid');
const baseSha = process.env.ORLOOM_PROOF_BASE_SHA, candidateSha = process.env.ORLOOM_PROOF_CANDIDATE_SHA;
assert.match(baseSha, /^[a-f0-9]{40}$/); assert.match(candidateSha, /^[a-f0-9]{40}$/);
const repository = 'nrsandoval1231-oss/orloom', checkId = 'node-validate-syntax', checks = [checkId];
const image = process.env.ORLOOM_VERIFIER_IMAGE;
const imageDigest = image.match(/^(?:sha256:|.+@sha256:)([a-f0-9]{64})$/)?.[1];
assert.ok(imageDigest, 'verifier image identity is invalid');
const leasePolicyDigest = sha(Buffer.from(JSON.stringify(checks)));
const objectStore = path.resolve(process.env.ORLOOM_PROOF_OBJECT_STORE);
const verifierEnv = { ...process.env, ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({ [repository]: { objectStore, approvedRef: 'refs/heads/candidate' } }) };
const policy = getCheckPolicy(checkId, image, imageDigest);
const artifactsDir = path.resolve(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT);
const evidenceRoot = path.resolve(process.env.ORLOOM_PROOF_EVIDENCE_DIR);
const evidenceDir = path.join(evidenceRoot, `continuation-${Date.now()}`);
await mkdir(evidenceDir, { recursive: false, mode: 0o700 });
const writeNew = (name, bytes) => writeFile(path.join(evidenceDir, name), bytes, { flag: 'wx', mode: 0o400 });
const dockerArgs = ['--config', process.env.ORLOOM_PROOF_DOCKER_CONFIG, '--host', 'unix:///var/run/docker.sock'];
const docker = async (...args) => (await exec('/usr/bin/docker', [...dockerArgs, ...args], { windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/root' } })).stdout;
const inspectCid = async cid => JSON.parse(await docker('inspect', '--format', '{{json .}}', cid));
let stage = 'configuration', database, auxiliary, control;
const safeFrame = error => {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return null;
  for (const line of error.stack.split('\n')) { const match = /continue-runtime-proof\.mjs:(\d+):(\d+)/.exec(line); if (match) return { line: Number(match[1]), column: Number(match[2]) }; }
  return null;
};
const makeCoordinator = async store => {
  const runner = await createTrustedVerificationRunner(verifierEnv);
  assert.ok(runner, 'trusted runner factory unexpectedly disabled');
  const coordinator = new TrustedCheckCoordinator(store, runner, {
    imageDigest, verifierId: process.env.ORLOOM_VERIFIER_ID, policyDigest: policy.digest,
    leasePolicyDigest, policyVersion: policy.version, allowedChecks: checks,
  });
  return { runner, coordinator };
};

try {
  stage = 'validate-quarantined-state-and-exact-cid';
  const statePath = '/var/lib/orloom/verifier/state';
  const stateRecord = (await readFile(statePath, 'utf8')).trim();
  assert.equal(stateRecord, `ORL-C3|${expectedRun}|${image}|${expectedCid}|running`);
  const oldContainer = await inspectCid(expectedCid);
  const oldConfig = {
    id: oldContainer.Id, name: oldContainer.Name, image: oldContainer.Config.Image, imageId: oldContainer.Image,
    user: oldContainer.Config.User, status: oldContainer.State.Status, running: oldContainer.State.Running,
    runtime: oldContainer.HostConfig.Runtime, networkMode: oldContainer.HostConfig.NetworkMode,
    memoryBytes: oldContainer.HostConfig.Memory, memorySwapBytes: oldContainer.HostConfig.MemorySwap,
    nanoCpus: oldContainer.HostConfig.NanoCpus, pidsLimit: oldContainer.HostConfig.PidsLimit,
    readOnlyRootfs: oldContainer.HostConfig.ReadonlyRootfs, capDrop: oldContainer.HostConfig.CapDrop,
    securityOpt: oldContainer.HostConfig.SecurityOpt, tmpfs: oldContainer.HostConfig.Tmpfs, mounts: oldContainer.Mounts,
    labels: { packet: oldContainer.Config.Labels?.['orloom.packet'], run: oldContainer.Config.Labels?.['orloom.run'] },
  };
  await writeNew('quarantined-container-observed.json', Buffer.from(JSON.stringify(oldConfig, null, 2)));
  assert.equal(oldConfig.id, expectedCid); assert.equal(oldConfig.name, `/${expectedRun}`);
  assert.equal(oldConfig.image, image); assert.equal(oldConfig.labels.packet, 'ORL-C3'); assert.equal(oldConfig.labels.run, expectedRun);
  assert.ok(image.startsWith('sha256:'), 'continuation is pinned to the reviewed local image ID');
  assert.equal(oldConfig.imageId, `sha256:${imageDigest}`);
  assert.equal(oldConfig.status, 'created'); assert.equal(oldConfig.running, false);
  assert.equal(oldConfig.runtime, 'runsc'); assert.equal(oldConfig.networkMode, 'none');
  assert.equal(oldConfig.memoryBytes, 268435456); assert.equal(oldConfig.memorySwapBytes, 268435456);
  assert.equal(oldConfig.nanoCpus, 500000000); assert.equal(oldConfig.pidsLimit, 64);
  assert.equal(oldConfig.readOnlyRootfs, true); assert.equal(oldConfig.user, '65532:65532'); assert.deepEqual(oldConfig.capDrop, ['ALL']);
  assert.ok(oldConfig.securityOpt.includes('no-new-privileges:true')); assert.deepEqual(oldConfig.mounts, []);
  assert.deepEqual(Object.keys(oldConfig.tmpfs).sort(), ['/tmp', '/work']);
  assert.ok(oldConfig.tmpfs['/tmp'].includes('size=16m') && oldConfig.tmpfs['/tmp'].includes('noexec'));
  assert.ok(oldConfig.tmpfs['/work'].includes('size=32m') && oldConfig.tmpfs['/work'].includes('exec'));
  const c3Containers = (await docker('ps', '-a', '--no-trunc', '--filter', 'label=orloom.packet=ORL-C3', '--format', '{{.ID}}')).trim().split('\n').filter(Boolean);
  assert.deepEqual(c3Containers, [expectedCid], 'only the exact quarantined sandbox may exist before continuation');

  stage = 'classify-original-attempt-unknown-in-primary';
  database = await PostgresJobStore.connect(databaseUrl);
  const original = await database.query(`SELECT a.attempt_id,a.request,a.outcome,a.capability_expires_at,m.id AS mission_id,m.objective
    FROM verification_attempts a JOIN missions m ON m.id=a.mission_id
    WHERE m.objective=$1 AND a.check_id=$2 ORDER BY a.created_at DESC`, [expectedMissionObjective, checkId]);
  assert.equal(original.rows.length, 1, 'must identify exactly one original interrupted attempt');
  const prior = original.rows[0], request = prior.request;
  assert.equal(request.candidateSha, candidateSha); assert.equal(request.repository, repository);
  if (prior.outcome === null) {
    control = await makeCoordinator(new SqlMissionStore(database));
    await assert.rejects(control.coordinator.run(request), error => error?.name === 'MissionConflictError');
    const cutoff = new Date(prior.capability_expires_at);
    let now = new Date();
    const naturalExpiryDeadline = Date.now() + 130_000;
    while (now < cutoff && Date.now() < naturalExpiryDeadline) { await new Promise(resolve => setTimeout(resolve, 5000)); now = new Date(); }
    assert.ok(now >= cutoff, 'original capability has not naturally expired; leave attempt deferred UNKNOWN');
    const due = await database.query('SELECT attempt_id FROM verification_attempts WHERE terminal_at IS NULL AND capability_expires_at <= $1 ORDER BY capability_expires_at', [now.toISOString()]);
    assert.deepEqual(due.rows.map(row => row.attempt_id), [prior.attempt_id], 'only the original attempt may be expired by this continuation');
    await control.coordinator.expire(now, 1);
  }
  const originalAfter = await database.query('SELECT outcome,request,receipt FROM verification_attempts WHERE attempt_id=$1', [prior.attempt_id]);
  assert.equal(originalAfter.rows.length, 1); assert.equal(originalAfter.rows[0].outcome, 'unknown');
  assert.deepEqual((await new SqlMissionStore(database).awaitingVerification(checks, 100)).filter(item => item.missionId === prior.mission_id), []);
  await writeNew('original-attempt-unknown.json', Buffer.from(JSON.stringify({ attemptId: prior.attempt_id, missionId: prior.mission_id, outcome: originalAfter.rows[0].outcome, request: originalAfter.rows[0].request, receipt: originalAfter.rows[0].receipt ?? null, originalRunName: expectedRun, originalContainerId: expectedCid }, null, 2)));
  await database.close(); database = undefined; control = undefined;

  stage = 'connect-auxiliary-proof-database';
  const auxUrl = new URL(databaseUrl); auxUrl.pathname = '/mission_proof_aux';
  auxiliary = await PostgresJobStore.connect(auxUrl.toString());
  const store = new SqlMissionStore(auxiliary);
  const { runner, coordinator } = await makeCoordinator(store);
  const capacityPath = '/var/lib/orloom/c3-proof-20261013/capacity-evidence.json';
  const capacityBytes = await readFile(capacityPath);
  assert.equal(sha(capacityBytes), process.env.ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256);
  await store.configureCapacity(1, process.env.ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256, new Date(Date.now() + 15 * 60_000).toISOString());
  stage = 'create-separate-valid-mission';
  const mission = await store.submit({ repository, baseSha, objective: 'Reconcile the original exact quarantined CID, then verify a separate fresh mission in the auxiliary proof database.', acceptance: ['Original attempt remains UNKNOWN; the genuine launcher removes its exact old CID before a separate verification passes.'], budgetCents: 100 });
  await store.recommendPlan(mission.id, [{ id: 'c3-reconcile-existing-cid', objective: 'Reconcile the exact persisted old CID before a separate trusted syntax check.', dependencies: [], owner: 'c3-runtime-proof-continuation', scopes: ['infra/verifier-isolation'], checks, budgetCents: 10 }], 'c3-runtime-proof-continuation');
  await store.approvePlan(mission.id);
  const grant = await store.claim(300, leasePolicyDigest); assert.ok(grant, 'fresh auxiliary proof mission claim failed');
  await store.complete(mission.id, grant.slice.id, grant.epoch, grant.leaseToken, grant.capabilityToken, candidateSha, []);
  stage = 'trusted-launcher-reconciles-prior-cid';
  await coordinator.verifySlice(mission.id, grant.slice.id);
  const certificate = await coordinator.getCertificate(mission.id, grant.slice.id, checkId);
  assert.ok(certificate); assert.equal(certificate.candidateSha, candidateSha); assert.equal(certificate.scope, 'local-exact-commit');
  stage = 'verify-old-container-and-host-state-cleared';
  await assert.rejects(inspectCid(expectedCid), error => error.code !== 0, 'trusted launcher must remove the exact prior CID');
  let stateAfter = ''; try { stateAfter = (await readFile(statePath, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(stateAfter, '', 'trusted launcher must clear the reconciled durable record');
  const oldInput = `/run/orloom-verifier-input/${expectedRun}`;
  const oldInputReal = await lstat(oldInput); assert.ok(oldInputReal.isDirectory() && !oldInputReal.isSymbolicLink());
  const certificateRow = await auxiliary.query('SELECT certificate,receipt FROM check_certificates WHERE mission_id=$1', [mission.id]);
  assert.equal(certificateRow.rows.length, 1);
  await runner.verifyArtifacts(certificateRow.rows[0].receipt);
  await writeNew('reconciliation-certificate.json', Buffer.from(JSON.stringify(certificateRow.rows[0].certificate, null, 2)));
  await writeNew('reconciliation-receipt.json', Buffer.from(JSON.stringify(certificateRow.rows[0].receipt, null, 2)));
  const staleConfig = process.env.ORLOOM_PROOF_STALE_CONFIG;
  assert.equal(staleConfig, '/run/orloom-verifier-docker.KSqn6I');
  const staleConfigStat = await lstat(staleConfig); assert.ok(staleConfigStat.isDirectory() && !staleConfigStat.isSymbolicLink());
  assert.ok(path.dirname(staleConfig) === '/run' && path.basename(staleConfig).startsWith('orloom-verifier-docker.'));
  await rm(oldInput, { recursive: true, force: false });
  await rm(staleConfig, { recursive: true, force: false });
  await writeNew('continuation-summary.json', Buffer.from(JSON.stringify({ status: 'PASS', sourceCandidate: candidateSha, originalAttempt: 'UNKNOWN', originalContainerId: expectedCid, reconciliation: 'trusted launcher exact-ID cleanup before separate valid auxiliary-database check', certificateId: certificate.certificate_id ?? certificate.certificateId, providerCalls: 0 }, null, 2)));
  const rows = [];
  for (const entry of await readdir(evidenceDir)) {
    const p = path.join(evidenceDir, entry), st = await lstat(p);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    rows.push(`${sha(await readFile(p))}  ${entry}`);
  }
  await writeNew('evidence-manifest.sha256', Buffer.from(`${rows.sort().join('\n')}\n`));
  process.stdout.write(JSON.stringify({ status: 'PASS', evidenceDir, originalAttempt: 'UNKNOWN', reconciledContainerId: expectedCid, certificateId: certificate.certificate_id ?? certificate.certificateId, providerCalls: 0 }) + '\n');
} catch (error) {
  try { await writeFile(path.join(evidenceDir, 'continuation-failure.json'), JSON.stringify({ status: 'UNKNOWN', stage, errorType: error instanceof Error ? error.name : 'unknown', errorFrame: safeFrame(error) }, null, 2), { flag: 'wx', mode: 0o400 }); } catch { /* keep diagnostics sanitized */ }
  process.stderr.write(`C3 continuation failed closed at stage ${stage}; detailed errors are not emitted.\n`);
  process.exitCode = 1;
} finally { await database?.close(); await auxiliary?.close(); }
