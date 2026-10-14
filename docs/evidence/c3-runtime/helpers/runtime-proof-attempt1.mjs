import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgresJobStore } from '../orloom-ci/dist/packages/contracts/src/postgres-store.js';
import { SqlMissionStore } from '../orloom-ci/dist/packages/contracts/src/sql-mission-store.js';
import { TrustedCheckCoordinator } from '../orloom-ci/dist/packages/governor/src/governor.js';
import { createTrustedVerificationRunner, getCheckPolicy } from '../orloom-ci/dist/apps/verifier/src/index.js';

const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const required = ['ORLOOM_PROOF_DATABASE_URL_FILE', 'ORLOOM_PROOF_OBJECT_STORE', 'ORLOOM_PROOF_BASE_SHA', 'ORLOOM_PROOF_CANDIDATE_SHA', 'ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256', 'ORLOOM_PROOF_DOCKER_CONFIG', 'ORLOOM_VERIFIER_IMAGE', 'ORLOOM_VERIFIER_ID', 'ORLOOM_VERIFIER_ARTIFACT_ROOT', 'ORLOOM_PROOF_EVIDENCE_DIR'];
for (const name of required) assert.ok(process.env[name], `${name} is required`);
const databaseUrl = (await readFile(process.env.ORLOOM_PROOF_DATABASE_URL_FILE, 'utf8')).trim();
assert.ok(/^postgres:\/\/mission_app:[a-f0-9]{64}@[0-9.]+:5432\/mission_proof$/.test(databaseUrl), 'database URL format is invalid');
const baseSha = process.env.ORLOOM_PROOF_BASE_SHA;
const candidateSha = process.env.ORLOOM_PROOF_CANDIDATE_SHA;
assert.match(baseSha, /^[a-f0-9]{40}$/); assert.match(candidateSha, /^[a-f0-9]{40}$/);
assert.match(process.env.ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256, /^[a-f0-9]{64}$/);
const repository = process.env.ORLOOM_PROOF_REPOSITORY ?? 'nrsandoval1231-oss/orloom';
const approvedRef = process.env.ORLOOM_PROOF_APPROVED_REF ?? 'refs/heads/candidate';
const objectStore = path.resolve(process.env.ORLOOM_PROOF_OBJECT_STORE);
const image = process.env.ORLOOM_VERIFIER_IMAGE;
const imageDigest = image.match(/^(?:sha256:|.+@sha256:)([a-f0-9]{64})$/)?.[1];
assert.ok(imageDigest, 'verifier image must use immutable local ID or repository digest');
const trustedChecks = ['node-validate-syntax'];
const leasePolicyDigest = sha(JSON.stringify(trustedChecks));
const verifierEnv = { ...process.env, ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({ [repository]: { objectStore, approvedRef } }) };
const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
const artifactsDir = path.resolve(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT);
const evidenceRoot = path.resolve(process.env.ORLOOM_PROOF_EVIDENCE_DIR);
const relativeEvidencePath = path.relative(process.cwd(), evidenceRoot);
assert.ok(relativeEvidencePath === '..' || relativeEvidencePath.startsWith(`..${path.sep}`), 'evidence directory must be outside the source worktree');
assert.ok(!evidenceRoot.split(path.sep).some(part => ['tmp', 'temp'].includes(part.toLowerCase())), 'evidence directory must not be temporary');
const evidenceDir = path.join(evidenceRoot, `c3-${randomUUID()}`);
const writeNew = (file, bytes) => writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
let stage = 'configuration';
let jobs;
let activeLauncherChild;
let activeLauncherExit;
let activeLauncherInput;

function childExit(child) { return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); }
async function inspectSandboxContainers() {
  const dockerConfig = process.env.ORLOOM_PROOF_DOCKER_CONFIG;
  assert.ok(dockerConfig && path.isAbsolute(dockerConfig));
  const { stdout } = await exec('/usr/bin/docker', ['--config', dockerConfig, '--host', 'unix:///var/run/docker.sock', 'ps', '-a', '--no-trunc', '--filter', 'label=orloom.packet=ORL-C3', '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Label "orloom.run"}}'], { windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  return stdout.trim().split('\n').filter(Boolean).sort();
}

async function openControl() {
  jobs = await PostgresJobStore.connect(databaseUrl);
  const store = new SqlMissionStore(jobs);
  const runner = await createTrustedVerificationRunner(verifierEnv);
  assert.ok(runner, 'trusted runner factory unexpectedly disabled');
  const policy = getCheckPolicy(trustedChecks[0], image, imageDigest);
  const coordinator = new TrustedCheckCoordinator(store, runner, {
    imageDigest, verifierId: process.env.ORLOOM_VERIFIER_ID, policyDigest: policy.digest,
    leasePolicyDigest, policyVersion: policy.version, allowedChecks: trustedChecks,
  });
  return { store, runner, coordinator, policy };
}

try {
  stage = 'open-postgres-and-runner';
  let control = await openControl();
  stage = 'capacity-and-mission-setup';
  await control.store.configureCapacity(1, process.env.ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256, deadline);
  const snapshotBundle = await control.runner.prepareBundle(repository, baseSha, candidateSha);
  await mkdir(path.join(evidenceDir, 'candidate'), { recursive: true, mode: 0o700 });
  await writeNew(path.join(evidenceDir, 'input-manifest.json'), snapshotBundle.manifest);
  for (const [relative, bytes] of snapshotBundle.files) {
    const target = path.join(evidenceDir, 'candidate', ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeNew(target, bytes);
  }
  const mission = await control.store.submit({ repository, baseSha, objective: 'Certify the frozen C3 source candidate with its real local syntax check.', acceptance: ['A durable runsc receipt is joined to one PostgreSQL certificate.'], budgetCents: 100 });
  await control.store.recommendPlan(mission.id, [{ id: 'c3-runner', objective: 'Run the frozen trusted syntax policy.', dependencies: [], owner: 'c3-runtime-proof', scopes: ['packages/verification'], checks: trustedChecks, budgetCents: 10 }], 'c3-runtime-proof');
  await control.store.approvePlan(mission.id);
  const grant = await control.store.claim(300, leasePolicyDigest);
  assert.ok(grant, 'real disposable PostgreSQL claim failed');
  await control.store.complete(mission.id, grant.slice.id, grant.epoch, grant.leaseToken, grant.capabilityToken, candidateSha, []);
  stage = 'genuine-runsc-coordinator-submission';
  await control.coordinator.verifySlice(mission.id, grant.slice.id);
  const cert = await control.coordinator.getCertificate(mission.id, grant.slice.id, trustedChecks[0]);
  assert.ok(cert, 'trusted runsc check did not produce a certificate');
  assert.equal(cert.scope, 'local-exact-commit');
  assert.equal(cert.candidateSha, candidateSha);
  assert.equal(cert.localHeadSha, candidateSha);
  stage = 'two-client-host-slot-contention';
  const lockPath = '/run/orloom-verifier-lock/slot.lock', statePath = '/var/lib/orloom/verifier/state';
  const lockStat = await lstat(lockPath); assert.ok(lockStat.isFile() && !lockStat.isSymbolicLink(), 'trusted host lock must be an ordinary file');
  let stateBefore = Buffer.alloc(0);
  try { const stateStat = await lstat(statePath); assert.ok(stateStat.isFile() && !stateStat.isSymbolicLink(), 'host state must be an ordinary file'); stateBefore = await readFile(statePath); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.equal(stateBefore.length, 0, 'proof requires a clear trusted verifier state');
  const collisionMission = await control.store.submit({ repository, baseSha, objective: 'Prove a second client cannot execute while the durable verifier slot is occupied.', acceptance: ['Busy slot produces UNKNOWN without sandbox creation or automatic retry.'], budgetCents: 100 });
  await control.store.recommendPlan(collisionMission.id, [{ id: 'c3-slot-collision', objective: 'Run the trusted check under a competing host slot owner.', dependencies: [], owner: 'c3-runtime-proof', scopes: ['apps/verifier'], checks: trustedChecks, budgetCents: 10 }], 'c3-runtime-proof');
  await control.store.approvePlan(collisionMission.id);
  const collisionGrant = await control.store.claim(300, leasePolicyDigest); assert.ok(collisionGrant, 'collision mission claim failed');
  await control.store.complete(collisionMission.id, collisionGrant.slice.id, collisionGrant.epoch, collisionGrant.leaseToken, collisionGrant.capabilityToken, candidateSha, []);
  const containersBefore = await inspectSandboxContainers();
  const lockOwner = spawn('/usr/bin/flock', ['--no-fork', '--nonblock', lockPath, '/bin/bash', '-c', 'printf "LOCK_HELD\\n"; exec /bin/sleep 120'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  const lockOwnerExit = childExit(lockOwner);
  let lockOutput = '';
  const lockReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock owner did not acquire slot')), 5000);
    lockOwner.stdout.setEncoding('utf8');
    lockOwner.stdout.on('data', chunk => { lockOutput += chunk; if (lockOutput.includes('LOCK_HELD')) { clearTimeout(timer); resolve(true); } });
    lockOwner.once('error', error => { clearTimeout(timer); reject(error); });
    lockOwner.once('exit', (code) => { if (!lockOutput.includes('LOCK_HELD')) { clearTimeout(timer); reject(new Error(`lock owner exited before acquiring slot (${code})`)); } });
  });
  try {
    await lockReady;
    const contender = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', lockPath, '/bin/true'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
    assert.equal((await childExit(contender)).code, 75, 'independent flock client must fail closed with busy exit 75');
    await control.coordinator.verifySlice(collisionMission.id, collisionGrant.slice.id);
  } finally { lockOwner.kill('SIGTERM'); await lockOwnerExit; }
  const collisionRows = await jobs.query('SELECT request,receipt,outcome FROM verification_attempts WHERE mission_id=$1 AND slice_id=$2 AND check_id=$3', [collisionMission.id, collisionGrant.slice.id, trustedChecks[0]]);
  assert.equal(collisionRows.rows.length, 1); assert.equal(collisionRows.rows[0].outcome, 'unknown'); assert.equal(collisionRows.rows[0].receipt.outcome, 'unknown');
  const collisionArtifacts = await control.runner.verifyArtifacts(collisionRows.rows[0].receipt);
  await writeNew(path.join(evidenceDir, 'host-slot-collision-request.json'), Buffer.from(JSON.stringify(collisionRows.rows[0].request, null, 2)));
  await writeNew(path.join(evidenceDir, 'host-slot-collision-receipt.json'), Buffer.from(JSON.stringify(collisionRows.rows[0].receipt, null, 2)));
  await writeNew(path.join(evidenceDir, 'host-slot-collision-stdout.bin'), collisionArtifacts.stdout);
  await writeNew(path.join(evidenceDir, 'host-slot-collision-stderr.bin'), collisionArtifacts.stderr);
  await writeNew(path.join(evidenceDir, 'host-slot-collision-input-manifest.json'), collisionArtifacts.manifest);
  assert.equal(await control.coordinator.getCertificate(collisionMission.id, collisionGrant.slice.id, trustedChecks[0]), null, 'busy slot cannot produce a certificate');
  assert.deepEqual(await inspectSandboxContainers(), containersBefore, 'busy slot must not create any runsc sandbox');
  const waitingAfterBusy = await control.store.awaitingVerification(trustedChecks, 50);
  assert.ok(!waitingAfterBusy.some(item => item.missionId === collisionMission.id), 'terminal busy-slot UNKNOWN must not be automatically redispatched');
  let stateAfter = Buffer.alloc(0);
  try { stateAfter = await readFile(statePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.deepEqual(stateAfter, stateBefore, 'failed second client must leave durable running intent unchanged');
  await writeNew(path.join(evidenceDir, 'host-slot-collision.json'), Buffer.from(JSON.stringify({ lockPath, competingProcessId: lockOwner.pid, secondFlockExitCode: 75, realCoordinatorRunnerAttempt: true, receiptOutcome: collisionRows.rows[0].receipt.outcome, sandboxContainersBefore: containersBefore, sandboxContainersAfter: await inspectSandboxContainers(), durableStateUnchanged: true, automaticRedispatch: false }, null, 2)));
  const freeSlotMission = await control.store.submit({ repository, baseSha, objective: 'Prove the trusted host slot runs normally after the competing client exits.', acceptance: ['A real runsc receipt and certificate succeed after release.'], budgetCents: 100 });
  await control.store.recommendPlan(freeSlotMission.id, [{ id: 'c3-slot-released', objective: 'Run the trusted syntax policy after slot release.', dependencies: [], owner: 'c3-runtime-proof', scopes: ['scripts'], checks: trustedChecks, budgetCents: 10 }], 'c3-runtime-proof');
  await control.store.approvePlan(freeSlotMission.id);
  const freeSlotGrant = await control.store.claim(300, leasePolicyDigest); assert.ok(freeSlotGrant, 'post-contention mission claim failed');
  await control.store.complete(freeSlotMission.id, freeSlotGrant.slice.id, freeSlotGrant.epoch, freeSlotGrant.leaseToken, freeSlotGrant.capabilityToken, candidateSha, []);
  await control.coordinator.verifySlice(freeSlotMission.id, freeSlotGrant.slice.id);
  const freeSlotCert = await control.coordinator.getCertificate(freeSlotMission.id, freeSlotGrant.slice.id, trustedChecks[0]);
  assert.ok(freeSlotCert, 'trusted runsc check must work after competing slot client releases');
  await writeNew(path.join(evidenceDir, 'host-slot-released-certificate.json'), Buffer.from(JSON.stringify(freeSlotCert, null, 2)));

  const rows = await jobs.query('SELECT request,receipt,capability_hash FROM verification_attempts WHERE mission_id=$1 AND slice_id=$2 AND check_id=$3', [mission.id, grant.slice.id, trustedChecks[0]]);
  assert.equal(rows.rows.length, 1, 'expected one durable verification attempt');
  const { request, receipt, capability_hash: capabilityHash } = rows.rows[0];
  assert.equal(receipt.outcome, 'pass');
  const artifactBytes = await control.runner.verifyArtifacts(receipt);
  assert.deepEqual(artifactBytes.manifest, snapshotBundle.manifest, 'persisted input manifest must match the exact extracted snapshot');
  await writeNew(path.join(evidenceDir, 'request.json'), Buffer.from(JSON.stringify(request, null, 2)));
  await writeNew(path.join(evidenceDir, 'receipt.json'), Buffer.from(JSON.stringify(receipt, null, 2)));
  await writeNew(path.join(evidenceDir, 'certificate.json'), Buffer.from(JSON.stringify(cert, null, 2)));
  await writeNew(path.join(evidenceDir, 'stdout.bin'), artifactBytes.stdout);
  await writeNew(path.join(evidenceDir, 'stderr.bin'), artifactBytes.stderr);
  const backendPids = await Promise.all(Array.from({ length: 6 }, async () => (await jobs.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
  assert.ok(new Set(backendPids).size >= 2, 'proof must demonstrate multiple PostgreSQL backend connections');
  await writeNew(path.join(evidenceDir, 'database-backend-pids.json'), Buffer.from(JSON.stringify(backendPids, null, 2)));
  await assert.rejects(control.store.submitVerification(receipt, sha('wrong capability'), candidateSha, new Date().toISOString(), sha('wrong observation'), randomUUID()), /capability|attempt/i);

  const outputPath = path.join(artifactsDir, receipt.stdout.sha256);
  const originalOutput = await readFile(outputPath);
  try {
    await writeFile(outputPath, Buffer.from('tampered verifier output'));
    await assert.rejects(control.runner.verifyArtifacts(receipt), /hash mismatch|byte count/i);
  } finally { await writeFile(outputPath, originalOutput); }
  await control.runner.verifyArtifacts(receipt);

  const head = await control.runner.observeHead(repository);
  const duplicateResults = await Promise.all([0, 1].map(() => control.store.submitVerification(receipt, capabilityHash, head.sha, head.observedAt, head.digest, randomUUID())));
  assert.deepEqual(duplicateResults[0], duplicateResults[1], 'concurrent identical submissions must return the same certificate');

  await exec('git', ['--git-dir', objectStore, 'update-ref', approvedRef, baseSha], { windowsHide: true });
  assert.equal(await control.coordinator.getCertificate(mission.id, grant.slice.id, trustedChecks[0]), null, 'stale local ref must hide the certificate');
  await exec('git', ['--git-dir', objectStore, 'update-ref', approvedRef, candidateSha], { windowsHide: true });

  stage = 'postgres-runner-coordinator-reconnect';
  await jobs.close(); jobs = undefined;
  control = await openControl();
  const afterReconnect = await control.coordinator.getCertificate(mission.id, grant.slice.id, trustedChecks[0]);
  assert.deepEqual(afterReconnect, cert, 'certificate must survive new PostgreSQL and coordinator instances');
  assert.equal((await jobs.query('SELECT count(*)::int AS n FROM check_certificates WHERE mission_id=$1', [mission.id])).rows[0].n, 1);
  stage = 'interrupted-real-launcher-cid-recovery';
  const interruptedMission = await control.store.submit({ repository, baseSha, objective: 'Exercise exact-CID sandbox interruption recovery without retrying the same attempt.', acceptance: ['Persisted launcher intent is reconciled before a separate valid attempt.'], budgetCents: 100 });
  await control.store.recommendPlan(interruptedMission.id, [{ id: 'c3-interrupt-cid', objective: 'Interrupt one real launch after its exact container ID is persisted.', dependencies: [], owner: 'c3-runtime-proof', scopes: ['packages/contracts'], checks: trustedChecks, budgetCents: 10 }], 'c3-runtime-proof');
  await control.store.approvePlan(interruptedMission.id);
  const interruptedGrant = await control.store.claim(300, leasePolicyDigest); assert.ok(interruptedGrant);
  await control.store.complete(interruptedMission.id, interruptedGrant.slice.id, interruptedGrant.epoch, interruptedGrant.leaseToken, interruptedGrant.capabilityToken, candidateSha, []);
  const interruptedRequest = await control.coordinator.prepare(interruptedMission.id, interruptedGrant.slice.id, trustedChecks[0]);
  const interruptedBundle = await control.runner.prepareBundle(repository, baseSha, candidateSha);
  const inputRoot = '/run/orloom-verifier-input', interruptName = `orloom-verifier-${randomUUID()}`;
  const rootStat = await lstat(inputRoot); assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const inputDir = path.join(inputRoot, interruptName); await mkdir(inputDir, { mode: 0o700 });
  activeLauncherInput = inputDir;
  await writeFile(path.join(inputDir, 'manifest.json'), interruptedBundle.manifest, { flag: 'wx', mode: 0o444 });
  const inputSource = path.join(inputDir, 'source'); await mkdir(inputSource, { mode: 0o555 });
  const inputDirs = new Set();
  for (const [fileName, bytes] of interruptedBundle.files) {
    const parts = fileName.split('/'); assert.ok(parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\')));
    for (let i = 1; i < parts.length; i++) inputDirs.add(parts.slice(0, i).join('/'));
    const parent = path.join(inputSource, ...parts.slice(0, -1)); await mkdir(parent, { recursive: true, mode: 0o555 });
    await writeFile(path.join(inputSource, ...parts), bytes, { flag: 'wx', mode: 0o444 });
  }
  for (const dir of [...inputDirs].sort((a,b)=>b.length-a.length)) await chmod(path.join(inputSource, ...dir.split('/')), 0o555);
  await chmod(inputSource, 0o555); await chmod(inputDir, 0o555);
  const launcherPath = process.env.ORLOOM_VERIFIER_LAUNCHER;
  assert.ok(launcherPath && path.isAbsolute(launcherPath));
  const configPrefix = 'orloom-verifier-docker.';
  const configsBefore = (await readdir('/run')).filter(name => name.startsWith(configPrefix));
  assert.deepEqual(configsBefore, [], 'unexpected stale launcher Docker config must be reconciled before proof');
  const launcherChild = spawn('/bin/bash', [launcherPath, interruptName], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C', ORLOOM_VERIFIER_IMAGE: image } });
  const launcherExit = childExit(launcherChild); let launcherOut = Buffer.alloc(0), launcherErr = Buffer.alloc(0);
  activeLauncherChild = launcherChild; activeLauncherExit = launcherExit;
  launcherChild.stdout.on('data', chunk => { if (launcherOut.length < 65_536) launcherOut = Buffer.concat([launcherOut, chunk.subarray(0, 65_536 - launcherOut.length)]); });
  launcherChild.stderr.on('data', chunk => { if (launcherErr.length < 65_536) launcherErr = Buffer.concat([launcherErr, chunk.subarray(0, 65_536 - launcherErr.length)]); });
  const interruptedStatePath = '/var/lib/orloom/verifier/state'; let stateRecord = '', cid;
  const pollDeadline = Date.now() + 5000;
  while (Date.now() < pollDeadline) {
    try {
      stateRecord = (await readFile(interruptedStatePath, 'utf8')).trim();
      const parts = stateRecord.split('|');
      if (parts.length === 5 && parts[0] === 'ORL-C3' && parts[1] === interruptName && parts[2] === image && /^[a-f0-9]{64}$/.test(parts[3]) && parts[4] === 'running') { cid = parts[3]; break; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (launcherChild.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(cid, 'bounded poll did not observe an exact persisted sandbox CID; leave attempt UNKNOWN and do not retry blindly');
  const dockerArgs = ['--config', process.env.ORLOOM_PROOF_DOCKER_CONFIG, '--host', 'unix:///var/run/docker.sock'];
  const inspectExact = async id => JSON.parse((await exec('/usr/bin/docker', [...dockerArgs, 'inspect', '--format', '{{json .}}', id], { windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/root' } })).stdout);
  const interruptedContainer = await inspectExact(cid);
  assert.equal(interruptedContainer.Id, cid); assert.equal(interruptedContainer.Config.Labels['orloom.packet'], 'ORL-C3');
  assert.equal(interruptedContainer.Config.Labels['orloom.run'], interruptName); assert.equal(interruptedContainer.Config.Image, image);
  const observedContainerState = interruptedContainer.State.Status;
  assert.ok(['running', 'exited'].includes(observedContainerState), 'only a running or completed sandbox may be recorded as observed');
  const observedContainerConfig = {
    id: interruptedContainer.Id,
    name: interruptedContainer.Name,
    image: interruptedContainer.Config.Image,
    user: interruptedContainer.Config.User,
    status: observedContainerState,
    runtime: interruptedContainer.HostConfig.Runtime,
    networkMode: interruptedContainer.HostConfig.NetworkMode,
    memoryBytes: interruptedContainer.HostConfig.Memory,
    memorySwapBytes: interruptedContainer.HostConfig.MemorySwap,
    nanoCpus: interruptedContainer.HostConfig.NanoCpus,
    pidsLimit: interruptedContainer.HostConfig.PidsLimit,
    readOnlyRootfs: interruptedContainer.HostConfig.ReadonlyRootfs,
    capDrop: interruptedContainer.HostConfig.CapDrop,
    securityOpt: interruptedContainer.HostConfig.SecurityOpt,
    tmpfs: interruptedContainer.HostConfig.Tmpfs,
    mounts: interruptedContainer.Mounts,
  };
  assert.equal(observedContainerConfig.runtime, 'runsc');
  assert.equal(observedContainerConfig.networkMode, 'none');
  assert.equal(observedContainerConfig.memoryBytes, 268435456);
  assert.equal(observedContainerConfig.memorySwapBytes, 268435456);
  assert.equal(observedContainerConfig.nanoCpus, 500000000);
  assert.equal(observedContainerConfig.pidsLimit, 64);
  assert.equal(observedContainerConfig.readOnlyRootfs, true);
  assert.equal(observedContainerConfig.user, '65532:65532');
  assert.deepEqual(observedContainerConfig.capDrop, ['ALL']);
  assert.ok(observedContainerConfig.securityOpt.includes('no-new-privileges:true'));
  assert.deepEqual(observedContainerConfig.mounts, []);
  const configsAfter = (await readdir('/run')).filter(name => name.startsWith(configPrefix));
  assert.equal(configsAfter.length, 1, 'interrupted invocation must have one unique temporary Docker config');
  const interruptedDockerConfig = path.join('/run', configsAfter[0]);
  const dockerConfigStat = await lstat(interruptedDockerConfig); assert.ok(dockerConfigStat.isDirectory() && !dockerConfigStat.isSymbolicLink());
  try { process.kill(-launcherChild.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  const launcherExitResult = await launcherExit;
  assert.equal(launcherExitResult.signal, 'SIGKILL', 'only the dedicated spawned launcher process group is interrupted');
  assert.equal((await readFile(interruptedStatePath, 'utf8')).trim(), stateRecord, 'SIGKILL must preserve exact intent and CID');
  await rm(interruptedDockerConfig, { recursive: true, force: false });
  const contenderAfterInterrupt = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', '/run/orloom-verifier-lock/slot.lock', '/bin/true'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  assert.equal((await childExit(contenderAfterInterrupt)).code, 0, 'interrupted launcher must release the host lock');
  await writeNew(path.join(evidenceDir, 'interrupted-launch-request.json'), Buffer.from(JSON.stringify(interruptedRequest, null, 2)));
  await writeNew(path.join(evidenceDir, 'interrupted-launch.json'), Buffer.from(JSON.stringify({ stateRecord, cid, observedContainerState, observedContainerConfig, launcherSignal: launcherExitResult.signal, stdoutSha256: sha(launcherOut), stderrSha256: sha(launcherErr), interruptedDockerConfig, configRemovedByExactPath: true, processRestartRecoveryRequired: true }, null, 2)));
  await rm(inputDir, { recursive: true, force: false });
  activeLauncherInput = undefined;
  activeLauncherChild = undefined; activeLauncherExit = undefined;
  await jobs.close(); jobs = undefined;
  control = await openControl();
  await assert.rejects(control.coordinator.run(interruptedRequest), /unavailable after process restart/);
  await control.store.expireVerificationAttempts(new Date(Date.parse(interruptedRequest.expiresAt) + 121_000));
  const interruptedAttempt = (await jobs.query('SELECT outcome FROM verification_attempts WHERE attempt_id=$1', [interruptedRequest.attemptId])).rows[0];
  assert.equal(interruptedAttempt.outcome, 'unknown');
  assert.deepEqual((await control.store.awaitingVerification(trustedChecks, 10)).filter(item => item.missionId === interruptedMission.id), [], 'interrupted attempt must not be automatically redispatched');
  const recoveryMission = await control.store.submit({ repository, baseSha, objective: 'Reconcile the recorded old CID, then perform a separate valid verification.', acceptance: ['Old exact CID is removed before a new sandbox can start.'], budgetCents: 100 });
  await control.store.recommendPlan(recoveryMission.id, [{ id: 'c3-reconcile-cid', objective: 'Reconcile old exact CID before the new trusted syntax check.', dependencies: [], owner: 'c3-runtime-proof', scopes: ['infra/verifier-isolation'], checks: trustedChecks, budgetCents: 10 }], 'c3-runtime-proof');
  await control.store.approvePlan(recoveryMission.id);
  const recoveryGrant = await control.store.claim(300, leasePolicyDigest); assert.ok(recoveryGrant);
  await control.store.complete(recoveryMission.id, recoveryGrant.slice.id, recoveryGrant.epoch, recoveryGrant.leaseToken, recoveryGrant.capabilityToken, candidateSha, []);
  await control.coordinator.verifySlice(recoveryMission.id, recoveryGrant.slice.id);
  const recoveryCert = await control.coordinator.getCertificate(recoveryMission.id, recoveryGrant.slice.id, trustedChecks[0]); assert.ok(recoveryCert);
  await assert.rejects(exec('/usr/bin/docker', [...dockerArgs, 'inspect', cid], { windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/root' } }), error => error.code !== 0, 'reconciled exact CID must no longer exist');
  let recoveryState = ''; try { recoveryState = (await readFile(interruptedStatePath, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.equal(recoveryState, '', 'successful next process must clear the reconciled host intent');
  await writeNew(path.join(evidenceDir, 'cid-recovery-certificate.json'), Buffer.from(JSON.stringify(recoveryCert, null, 2)));
  await writeNew(path.join(evidenceDir, 'summary.json'), Buffer.from(JSON.stringify({ status: 'PASS', missionId: mission.id, sliceId: grant.slice.id, attemptId: request.attemptId, certificateId: cert.certificateId, candidateSha, baseSha, receiptDigest: cert.receiptDigest, policyDigest: control.policy.digest, imageDigest, scope: cert.scope, backendPids, negatives: ['store-boundary-wrong-capability', 'artifact-tamper', 'concurrent-identical-submission', 'stale-local-head', 'separate-process-slot-contention-unknown-no-container-no-redispatch', 'exact-CID-launcher-SIGKILL-restart-reconciliation-before-next-valid-run'], processRestart: 'new-PostgreSQL-pool-runner-and-coordinator-instances', providerCalls: 0 }, null, 2)));
  const evidenceFiles = [];
  const collect = async dir => { for (const name of await readdir(dir)) { const target = path.join(dir, name); const st = await lstat(target); if (st.isSymbolicLink()) throw new Error('evidence symlink'); if (st.isDirectory()) await collect(target); else if (st.isFile() && name !== 'evidence-manifest.sha256') evidenceFiles.push(`${sha(await readFile(target))}  ${path.relative(evidenceDir, target).split(path.sep).join('/')}`); else throw new Error('unexpected evidence entry'); } };
  await collect(evidenceDir);
  await writeNew(path.join(evidenceDir, 'evidence-manifest.sha256'), Buffer.from(`${evidenceFiles.sort().join('\n')}\n`));
  process.stdout.write(JSON.stringify({ status: 'PASS', evidenceDir, missionId: mission.id, sliceId: grant.slice.id, attemptId: request.attemptId, certificateId: cert.certificateId, candidateSha, receiptDigest: cert.receiptDigest, scope: cert.scope, providerCalls: 0 }) + '\n');
} catch (error) {
  const errorType = error instanceof Error ? error.name : 'unknown';
  if (activeLauncherChild && activeLauncherChild.exitCode === null && activeLauncherChild.pid) {
    try { process.kill(-activeLauncherChild.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') { /* keep failure output sanitized */ } }
    await activeLauncherExit;
  }
  try { await writeFile(path.join(evidenceDir, 'proof-failure.json'), JSON.stringify({ status: 'UNKNOWN', stage, errorType, interruptedInputPath: activeLauncherInput ?? null }, null, 2), { flag: 'wx', mode: 0o400 }); } catch { /* preserve primary failed proof result */ }
  process.stderr.write(`C3 proof failed closed at stage ${stage} (${errorType}); detailed errors are not written to stdout/stderr because they may contain sensitive connection or host data.\n`);
  process.exitCode = 1;
} finally { await jobs?.close(); }
