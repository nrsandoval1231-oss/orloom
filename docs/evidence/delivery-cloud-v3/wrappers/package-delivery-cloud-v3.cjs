const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { root, helpers, sha, fail, binding, candidateDir, writeNewJson } = require('./common-delivery-cloud-v3.cjs');

const bound = binding();
const repo = bound.sourceRepo;
const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
if (git('rev-parse', 'HEAD') !== bound.candidateSha || git('rev-parse', `${bound.sourceRef}^{commit}`) !== bound.candidateSha) fail('Checkout HEAD and approved source ref must equal frozen candidate SHA');
if (git('status', '--porcelain=v1')) fail('Candidate checkout must be clean');
git('merge-base', '--is-ancestor', bound.baseSha, bound.candidateSha);
const sourceManifest = fs.readFileSync(path.join(repo, '.agent/ORL-C3-SUITE-MANIFEST.sha256'));
if (sha(sourceManifest) !== bound.sourceManifestSha256) fail('Source manifest differs from frozen binding');

function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`Symlink in source tests: ${file}`);
    if (entry.isDirectory()) findTests(file, found);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(path.relative(repo, file).replaceAll(path.sep, '/'));
  }
  return found;
}
const testFiles = findTests(path.join(repo, 'tests')).sort();
if (!testFiles.length) fail('Source test manifest is empty');
const dir = candidateDir(bound);
fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
fs.copyFileSync(path.join(root, 'source-review-v3.json'), path.join(dir, 'source-review-v3.json'), fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(root, 'source-review-admission-v3.json'), path.join(dir, 'source-review-admission-v3.json'), fs.constants.COPYFILE_EXCL);
const runtimeDir = path.join(dir, 'runtime-files');
const transferDir = path.join(dir, 'transfer');
const env = {
  ...process.env,
  ORLOOM_DELIVERY_SOURCE_REPO: repo,
  ORLOOM_DELIVERY_CANDIDATE_SHA: bound.candidateSha,
  ORLOOM_DELIVERY_BASE_SHA: bound.baseSha,
  ORLOOM_DELIVERY_SOURCE_REF: bound.sourceRef,
  ORLOOM_DELIVERY_SOURCE_MANIFEST_SHA256: bound.sourceManifestSha256,
  ORLOOM_DELIVERY_RUNTIME_FILES: runtimeDir,
  ORLOOM_DELIVERY_TRANSFER_DIR: transferDir,
};
for (const name of ['prepare-delivery-runtime.mjs', 'prepare-delivery-transfer.mjs']) {
  const output = path.join(dir, `${name}.log`);
  const result = cp.spawnSync(process.execPath, [path.join(helpers, name)], { cwd: dir, env, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(output, `${result.stdout || ''}${result.stderr || ''}`, { flag: 'wx', mode: 0o600 });
  if (result.status !== 0) fail(`Local package derivation failed: ${name} (${result.status ?? result.signal})`);
}

const runtimeIdentity = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'runtime-files-identity.json'), 'utf8'));
const helperNames = fs.readdirSync(helpers).filter(name => /^(?:[a-z-]+\.sh|[a-z-]+\.mjs)$/.test(name)).sort();
const hashHelper = name => sha(fs.readFileSync(path.join(helpers, name)));
const stageBindings = {
  approvedRef: bound.sourceRef, baseSha: bound.baseSha, candidateSha: bound.candidateSha,
  sourceManifestFileCount: sourceManifest.toString('utf8').trimEnd().split('\n').length,
  fixtureHelperSha256: hashHelper('prepare-acceptance-fixtures.mjs'),
  observerHelperSha256: hashHelper('cgroup-observer.mjs'),
  runtimeEntrySha256: hashHelper('runtime-acceptance-entry.mjs'),
  runtimeHelperSha256: hashHelper('runtime-acceptance.mjs'),
  runtimePayloadSha256: runtimeIdentity.payloadManifestSha256,
  runtimeFileCount: runtimeIdentity.fileCount,
  compiledJsCount: runtimeIdentity.compiledJsCount,
  migrationCount: runtimeIdentity.migrationCount,
  dependencyPackageCount: runtimeIdentity.dependencyPackageCount,
  runtimeSnapshotSha256: hashHelper('runtime-snapshot-export.mjs'),
  runtimeSnapshotShellSha256: hashHelper('export-acceptance-snapshot.sh'),
  sourceManifestSha256: bound.sourceManifestSha256,
};
const stageBytes = Buffer.from(`${JSON.stringify(stageBindings, null, 2)}\n`);
fs.writeFileSync(path.join(helpers, 'stage-bindings-v3.json'), stageBytes, { flag: 'wx', mode: 0o600 });
const helperFiles = [...helperNames, 'stage-bindings-v3.json'].map(file => {
  const bytes = fs.readFileSync(path.join(helpers, file));
  if (bytes.includes(13)) fail(`CR byte is forbidden in reviewed helpers: ${file}`);
  return { file, sha256: sha(bytes), bytes: bytes.length };
});
const helperManifest = {
  format: 'orloom-c3-delivery-cloud-helper-manifest-v1',
  candidateSha: bound.candidateSha,
  sourceManifestSha256: bound.sourceManifestSha256,
  sourceReviewSha256: bound.sourceReviewSha256,
  sourceReviewAdmissionSha256: bound.sourceReviewAdmissionSha256,
  files: helperFiles,
};
const helperBytes = Buffer.from(`${JSON.stringify(helperManifest, null, 2)}\n`);
fs.writeFileSync(path.join(helpers, 'helper-manifest-v3.json'), helperBytes, { flag: 'wx', mode: 0o600 });
for (const file of [...helperNames, 'stage-bindings-v3.json']) {
  fs.copyFileSync(path.join(helpers, file), path.join(transferDir, file), fs.constants.COPYFILE_EXCL);
}
fs.copyFileSync(path.join(helpers, 'helper-manifest-v3.json'), path.join(transferDir, 'helper-manifest.json'), fs.constants.COPYFILE_EXCL);

const selected = {
  format: 'orloom-c3-delivery-cloud-prepared-candidate-v1',
  candidateSha: bound.candidateSha, baseSha: bound.baseSha, sourceRef: bound.sourceRef,
  sourceManifestSha256: bound.sourceManifestSha256, sourceManifestFileCount: sourceManifest.toString('utf8').trimEnd().split('\n').length,
  sourceTestFileCount: testFiles.length, sourceTestFiles: testFiles,
  sourceReviewSha256: bound.sourceReviewSha256,
  sourceReviewAdmissionSha256: bound.sourceReviewAdmissionSha256,
  helperManifestSha256: sha(helperBytes),
  runtimePayloadManifestSha256: runtimeIdentity.payloadManifestSha256,
  runtimePayloadFileCount: runtimeIdentity.fileCount,
  runtimeCompiledJsCount: runtimeIdentity.compiledJsCount,
  runtimeMigrationCount: runtimeIdentity.migrationCount,
  runtimeDependencyPackageCount: runtimeIdentity.dependencyPackageCount,
  runtimeDependencyRoots: runtimeIdentity.dependencyRoots,
  runtimeOptionalDependencyExclusions: runtimeIdentity.optionalDependencyExclusions,
  transfer: transferDir, helpers,
  capacityObservation: { status: 'NOT-OBSERVED', freshnessWindowMs: 1800000, eachAttemptRequiresFreshAdmission: true },
  runtimeAttempt: { status: 'NOT-RUN' },
};
writeNewJson(path.join(dir, 'selected-transfer.json'), selected);
process.stdout.write(`${JSON.stringify({ ...selected, sourceTestFiles: undefined, helpers: undefined })}\n`);
