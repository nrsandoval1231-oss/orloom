import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const [databaseUrlFile, evidenceDir, bindingFile] = process.argv.slice(2);
const name = 'acceptance-snapshot.json', hashName = 'acceptance-snapshot.sha256';
const fail = (stage, error) => {
  const kind = error instanceof Error ? error.name : 'unknown';
  process.stderr.write(`acceptance snapshot export UNKNOWN at ${stage} (${kind}); no credential values emitted\n`);
  process.exitCode = 75;
};

let client;
try {
  assert.equal(process.getuid?.(), 0, 'root execution required');
  assert.ok(databaseUrlFile && path.isAbsolute(databaseUrlFile));
  assert.ok(evidenceDir && path.isAbsolute(evidenceDir));
  assert.ok(bindingFile && path.isAbsolute(bindingFile));
  const runtimeRoot = process.env.ORLOOM_ACCEPTANCE_CONTROL_ROOT;
  assert.ok(runtimeRoot && path.isAbsolute(runtimeRoot));
  const evidence = await stat(evidenceDir), bindingStat = await stat(bindingFile);
  assert.ok(evidence.isDirectory() && (evidence.mode & 0o077) === 0, 'evidence directory must be private');
  assert.ok(bindingStat.isFile() && (bindingStat.mode & 0o077) === 0, 'stage binding must be private');
  const binding = JSON.parse(await readFile(bindingFile, 'utf8'));
  assert.match(binding.candidateSha, /^[a-f0-9]{40}$/);
  assert.match(binding.sourceManifestSha256, /^[a-f0-9]{64}$/);
  const databaseUrl = (await readFile(databaseUrlFile, 'utf8')).trim();
  assert.ok(/^postgres:\/\/mission_app:[a-f0-9]{64}@[0-9.]+:5432\/mission_proof$/.test(databaseUrl), 'database URL file is malformed');
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const { Client } = require('pg');
  client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 12_000 });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10000ms'");
  const queried = await client.query(`
    SELECT a.attempt_id::text AS attempt_id, a.mission_id::text AS mission_id, a.slice_id,
      a.lease_epoch::text AS lease_epoch, a.check_id, a.request, a.outcome,
      a.receipt, a.created_at::text AS created_at, a.terminal_at::text AS terminal_at,
      c.certificate_id::text AS certificate_id, c.certificate, c.created_at::text AS certificate_created_at
    FROM verification_attempts a
    LEFT JOIN check_certificates c ON c.attempt_id = a.attempt_id
    ORDER BY a.created_at, a.attempt_id
    LIMIT 1001`);
  assert.ok(queried.rows.length <= 1000, 'attempt export exceeds the reviewed finite row bound');
  await client.query('COMMIT');

  const str = (value, max = 512) => { assert.equal(typeof value, 'string'); assert.ok(value.length > 0 && value.length <= max); return value; };
  const sha = value => { str(value, 64); assert.match(value, /^[a-f0-9]{64}$/); return value; };
  const requestView = value => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const r = value;
    assert.equal(r.version, 'orloom.trusted-check-request.v1');
    assert.match(str(r.attemptId), /^[a-f0-9-]{36}$/);
    assert.match(str(r.candidateSha), /^[a-f0-9]{40}$/);
    assert.match(str(r.expectedLocalHeadSha), /^[a-f0-9]{40}$/);
    return {
      version: r.version, attemptId: r.attemptId, missionId: str(r.missionId), sliceId: str(r.sliceId),
      leaseEpoch: r.leaseEpoch, repository: str(r.repository), candidateSha: r.candidateSha,
      expectedLocalHeadSha: r.expectedLocalHeadSha, planDigest: sha(r.planDigest), checkId: str(r.checkId),
      policyVersion: str(r.policyVersion), policyDigest: sha(r.policyDigest), verifierImageDigest: sha(r.verifierImageDigest),
      inputBundleDigest: sha(r.inputBundleDigest), requestedAt: str(r.requestedAt), expiresAt: str(r.expiresAt),
    };
  };
  const artifactView = value => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return { key: str(value.key, 256), sha256: sha(value.sha256), bytes: value.bytes };
  };
  const receiptView = value => {
    if (value === null) return null;
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(value.version, 'orloom.trusted-check-receipt.v1');
    assert.ok(['pass', 'fail', 'unknown'].includes(value.outcome));
    assert.ok(value.exitCode === null || Number.isSafeInteger(value.exitCode));
    assert.equal(value.runtime, 'runsc');
    return {
      version: value.version, request: requestView(value.request), verifierId: str(value.verifierId), runtime: value.runtime,
      sandboxId: str(value.sandboxId), outcome: value.outcome, exitCode: value.exitCode,
      startedAt: str(value.startedAt), finishedAt: str(value.finishedAt), stdout: artifactView(value.stdout),
      stderr: artifactView(value.stderr), inputManifest: artifactView(value.inputManifest), receiptDigest: sha(value.receiptDigest),
    };
  };
  const certificateView = value => {
    if (value === null) return null;
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(value.version, 'orloom.check-certificate.v1');
    assert.equal(value.scope, 'local-exact-commit');
    return {
      version: value.version, certificateId: str(value.certificateId), attemptId: str(value.attemptId),
      missionId: str(value.missionId), sliceId: str(value.sliceId), leaseEpoch: value.leaseEpoch,
      repository: str(value.repository), candidateSha: str(value.candidateSha), localHeadSha: str(value.localHeadSha),
      checkId: str(value.checkId), planDigest: sha(value.planDigest), policyVersion: str(value.policyVersion),
      policyDigest: sha(value.policyDigest), receiptDigest: sha(value.receiptDigest), certifiedAt: str(value.certifiedAt), scope: value.scope,
    };
  };
  const attempts = queried.rows.map(row => {
    const attemptId = str(row.attempt_id), request = requestView(row.request), receipt = receiptView(row.receipt);
    assert.equal(request.attemptId, attemptId);
    if (receipt) assert.equal(receipt.request.attemptId, attemptId);
    assert.ok(row.outcome === null || ['pass', 'fail', 'unknown'].includes(row.outcome));
    assert.ok(Number.isSafeInteger(Number(row.lease_epoch)) && Number(row.lease_epoch) > 0);
    return {
      attemptId, missionId: str(row.mission_id), sliceId: str(row.slice_id), leaseEpoch: Number(row.lease_epoch),
      checkId: str(row.check_id), outcome: row.outcome, request, receipt,
      createdAt: str(row.created_at), terminalAt: row.terminal_at, certificatePresent: row.certificate !== null,
    };
  });
  const certificates = queried.rows.filter(row => row.certificate !== null).map(row => ({
    certificateId: str(row.certificate_id), attemptId: str(row.attempt_id), createdAt: str(row.certificate_created_at),
    certificate: certificateView(row.certificate),
  }));
  for (const item of certificates) assert.equal(item.certificate.attemptId, item.attemptId);
  const snapshot = {
    format: 'orloom-c3-suite-acceptance-snapshot-v1', querySucceeded: true,
    candidateSha: binding.candidateSha, sourceManifestSha256: binding.sourceManifestSha256,
    exportedAt: new Date().toISOString(), attempts, certificates,
  };
  const target = path.join(evidenceDir, name), checksum = path.join(evidenceDir, hashName);
  let bytes;
  try {
    const priorStat = await lstat(target);
    assert.ok(priorStat.isFile() && !priorStat.isSymbolicLink() && (priorStat.mode & 0o777) === 0o400, 'existing acceptance snapshot is unsafe');
    bytes = await readFile(target);
    const prior = JSON.parse(bytes.toString('utf8'));
    assert.equal(prior.format, snapshot.format); assert.equal(prior.querySucceeded, true);
    assert.equal(prior.candidateSha, snapshot.candidateSha); assert.equal(prior.sourceManifestSha256, snapshot.sourceManifestSha256);
    assert.deepEqual(prior.attempts, attempts, 'existing snapshot attempts differ from current database state');
    assert.deepEqual(prior.certificates, certificates, 'existing snapshot certificates differ from current database state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o400 });
    await chmod(target, 0o400);
  }
  const expectedHash = `${digest(bytes)}  ${name}\n`;
  try {
    const checksumStat = await lstat(checksum);
    assert.ok(checksumStat.isFile() && !checksumStat.isSymbolicLink() && (checksumStat.mode & 0o777) === 0o400, 'existing acceptance snapshot checksum is unsafe');
    const existingHash = await readFile(checksum, 'utf8');
    assert.equal(existingHash, expectedHash, 'existing acceptance snapshot checksum differs');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(checksum, expectedHash, { flag: 'wx', mode: 0o400 });
    await chmod(checksum, 0o400);
  }
  process.stdout.write(`acceptance snapshot export PASS attempts=${attempts.length} certificates=${certificates.length}\n`);
} catch (error) {
  fail('read-only-postgresql-query', error);
} finally {
  try { await client?.end(); } catch { /* sanitized fail-closed path */ }
}
