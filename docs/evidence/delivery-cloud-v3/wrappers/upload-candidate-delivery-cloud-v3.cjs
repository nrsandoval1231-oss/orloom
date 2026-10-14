const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { root, sha, fail, readHelperManifest, candidateDir, selected, verifyRuntimePayload, verifyReviewPackageFiles, readJson } = require('./common-delivery-cloud-v3.cjs');

const [helperSha, reviewPackageSha, mode] = process.argv.slice(2);
if (mode !== undefined && mode !== '--admission-only') fail('Unsupported upload mode');
const { bound, manifest } = readHelperManifest(helperSha);
const pkgDir = candidateDir(bound), chosen = selected(bound);
const reviewFile = path.join(pkgDir, 'review-package-v3-complete.json');
if (!/^[a-f0-9]{64}$/.test(reviewPackageSha || '') || sha(fs.readFileSync(reviewFile)) !== reviewPackageSha) fail('Exact independently reviewed preparation-package SHA-256 is required');
const review = readJson(reviewFile);
if (review.candidateSha !== bound.candidateSha || review.helperManifestSha256 !== helperSha || review.sourceReviewSha256 !== bound.sourceReviewSha256 || review.sourceReviewAdmissionSha256 !== bound.sourceReviewAdmissionSha256 || review.hostActionsPerformed !== 0 || review.runtimeAttempt !== 'NOT-RUN' || review.capacityObservation !== 'NOT-OBSERVED') fail('Preparation review package is not exact or already records an action');
verifyReviewPackageFiles(review);
const identity = readJson(path.join(chosen.transfer, 'candidate-identity.json'));
if (identity.candidateSha !== bound.candidateSha || identity.baseSha !== bound.baseSha || identity.sourceRef !== bound.sourceRef || identity.sourceManifestSha256 !== bound.sourceManifestSha256) fail('Candidate bundle identity differs from approved binding');
if (sha(fs.readFileSync(path.join(chosen.transfer, 'candidate.bundle'))) !== identity.bundleSha256) fail('Candidate bundle hash differs');
verifyRuntimePayload(chosen);
for (const item of manifest.files) if (sha(fs.readFileSync(path.join(chosen.transfer, item.file))) !== item.sha256) fail(`Prepared transfer helper changed: ${item.file}`);

if (mode === '--admission-only') {
  process.stdout.write(`${JSON.stringify({ admitted: true, mode, candidateSha: bound.candidateSha, helperManifestSha256: helperSha, reviewPackageSha256: reviewPackageSha, reviewFile, executionDir: path.join(candidateDir(bound), 'executions'), hostActionsPerformed: 0 })}\n`);
  process.exit(0);
}

const host = 'codex-dark-peak-5042';
const incoming = '/var/lib/orloom/c3-delivery-v3-20261013.incoming';
const remote = [
  'set -euo pipefail', 'umask 077',
  'root=/var/lib/orloom/c3-delivery-v3-20261013',
  'incoming=$root.incoming',
  '[[ $EUID -eq 0 && -d /var/lib/orloom && ! -L /var/lib/orloom && ! -e "$root" && ! -L "$root" && ! -e "$incoming" && ! -L "$incoming" ]] || exit 73',
  'install -d -m 0700 "$incoming"',
  '',
].join('\n');
const executionDir = path.join(candidateDir(bound), 'executions');
fs.mkdirSync(executionDir, { recursive: true, mode: 0o700 });
const records = [];
function run(bin, args, input) {
  const startedUtc = new Date().toISOString();
  const result = cp.spawnSync(bin, args, { input, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  const record = { bin, args, startedUtc, finishedUtc: new Date().toISOString(), exit: result.status, stdout: result.stdout, stderr: result.stderr };
  records.push(record);
  fs.writeFileSync(path.join(executionDir, 'upload-record.json'), `${JSON.stringify({ helperManifestSha256: helperSha, reviewPackageSha256: reviewPackageSha, candidateSha: bound.candidateSha, records }, null, 2)}\n`);
  if (result.status !== 0) fail('Upload stopped; retain and inspect the local process record before any recovery');
}
run('ssh', ['-T', '-o', 'BatchMode=yes', host, 'bash', '-s'], remote);
const files = [
  path.join(chosen.transfer, 'runtime-files'), path.join(chosen.transfer, 'candidate.bundle'),
  path.join(chosen.transfer, 'candidate-identity.json'), ...manifest.files.map(item => path.join(chosen.transfer, item.file)),
  path.join(chosen.transfer, 'helper-manifest.json'),
];
run('scp', ['-q', '-r', '-o', 'BatchMode=yes', ...files, `${host}:${incoming}/`]);
process.stdout.write(`${JSON.stringify({ uploaded: true, candidateSha: bound.candidateSha, helperManifestSha256: helperSha, incoming })}\n`);
