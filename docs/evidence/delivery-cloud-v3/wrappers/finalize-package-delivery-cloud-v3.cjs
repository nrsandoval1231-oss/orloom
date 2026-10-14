const fs = require('node:fs');
const path = require('node:path');
const { root, sha, fail, binding, candidateDir, selected, verifyRuntimePayload, writeNewJson } = require('./common-delivery-cloud-v3.cjs');

const bound = binding(), packageDir = candidateDir(bound), chosen = selected(bound);
const manifestBytes = fs.readFileSync(path.join(root, 'helpers/helper-manifest-v3.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (sha(manifestBytes) !== chosen.helperManifestSha256 || manifest.candidateSha !== bound.candidateSha || manifest.sourceManifestSha256 !== bound.sourceManifestSha256) fail('Reviewed helper manifest does not match candidate package');
for (const item of manifest.files) {
  if (sha(fs.readFileSync(path.join(root, 'helpers', item.file))) !== item.sha256 || sha(fs.readFileSync(path.join(chosen.transfer, item.file))) !== item.sha256) fail(`Helper inventory mismatch: ${item.file}`);
}
const derivation = JSON.parse(fs.readFileSync(path.join(packageDir, 'derivation.json'), 'utf8'));
if (derivation.status !== 'PASS' || derivation.candidateSha !== bound.candidateSha || derivation.sourceManifestSha256 !== bound.sourceManifestSha256 || derivation.helperManifestSha256 !== sha(manifestBytes) || derivation.runtimePayloadManifestSha256 !== chosen.runtimePayloadManifestSha256) fail('Fresh candidate derivation is absent or mismatched');
const { payload: payloadPath, rows: payloadRows } = verifyRuntimePayload(chosen);
function countFiles(dir, predicate, prefix = '') {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name), relative = path.posix.join(prefix, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail(`Symlink in runtime count inventory: ${relative}`);
    if (stat.isDirectory()) count += countFiles(file, predicate, relative);
    else if (stat.isFile() && predicate(relative)) count++;
    else if (!stat.isFile()) fail(`Unexpected runtime count entry: ${relative}`);
  }
  return count;
}
const runtimeIdentity = JSON.parse(fs.readFileSync(path.join(payloadPath, 'runtime-files-identity.json'), 'utf8'));
const transferIdentity = JSON.parse(fs.readFileSync(path.join(chosen.transfer, 'candidate-identity.json'), 'utf8'));
const actualCounts = {
  compiledJsCount: countFiles(payloadPath, relative => relative.startsWith('dist/') && relative.endsWith('.js')),
  migrationCount: countFiles(payloadPath, relative => relative.startsWith('db/migrations/') && relative.endsWith('.sql')),
  dependencyPackageCount: countFiles(payloadPath, relative => relative.startsWith('node_modules/') && relative.endsWith('/package.json')),
};
for (const [field, count] of Object.entries(actualCounts)) {
  if (runtimeIdentity[field] !== count || chosen[`runtime${field[0].toUpperCase()}${field.slice(1)}`] !== count) fail(`Runtime identity ${field} differs from actual payload filesystem`);
  if (field !== 'dependencyPackageCount' && transferIdentity[field] !== count) fail(`Transfer identity ${field} differs from actual payload filesystem`);
}
if (runtimeIdentity.fileCount !== payloadRows.length || transferIdentity.runtimeFileCount !== payloadRows.length) fail('Runtime file count differs from actual payload manifest');
const records = [];
function add(file) {
  const bytes = fs.readFileSync(file);
  records.push({ file: path.relative(path.join(root, '..'), file).replaceAll(path.sep, '/'), bytes: bytes.length, sha256: sha(bytes) });
}
for (const file of ['bind-delivery-cloud-v3.cjs', 'package-delivery-cloud-v3.cjs', 'common-delivery-cloud-v3.cjs', 'verify-derivation-delivery-cloud-v3.cjs', 'finalize-package-delivery-cloud-v3.cjs', 'upload-candidate-delivery-cloud-v3.cjs', 'run-suite-script-delivery-cloud-v3.cjs', 'retain-evidence-delivery-cloud-v3.cjs', 'postflight-delivery-cloud-v3.cjs']) add(path.join(root, '..', file));
for (const item of manifest.files) add(path.join(root, 'helpers', item.file));
add(path.join(root, 'stage-predicate-cases-v3.json'));
add(path.join(root, 'PACKET.md'));
add(path.join(root, 'README.md'));
for (const file of ['selected-transfer.json', 'derivation.json', 'source-review-v3.json', 'source-review-admission-v3.json', 'prepare-delivery-runtime.mjs.log', 'prepare-delivery-transfer.mjs.log']) add(path.join(packageDir, file));
for (const file of ['candidate.bundle', 'candidate-identity.json', 'runtime-files/runtime-files.sha256', 'runtime-files/runtime-files-identity.json', ...manifest.files.map(item => item.file), 'helper-manifest.json', 'stage-bindings-v3.json']) add(path.join(chosen.transfer, file));
records.sort((a, b) => a.file.localeCompare(b.file));
const reviewPackage = {
  format: 'orloom-c3-delivery-cloud-prepared-review-package-v1',
  candidateSha: bound.candidateSha, baseSha: bound.baseSha, sourceRef: bound.sourceRef,
  sourceManifestSha256: bound.sourceManifestSha256, sourceManifestFileCount: chosen.sourceManifestFileCount,
  sourceTestFileCount: chosen.sourceTestFileCount, sourceReviewSha256: bound.sourceReviewSha256,
  sourceReviewAdmissionSha256: bound.sourceReviewAdmissionSha256,
  helperManifestSha256: sha(manifestBytes), helperFileCount: manifest.files.length,
  runtimePayloadManifestSha256: chosen.runtimePayloadManifestSha256,
  runtimePayloadFileCount: payloadRows.length,
  capacityObservation: 'NOT-OBSERVED', runtimeAttempt: 'NOT-RUN', hostActionsPerformed: 0,
  files: records,
};
writeNewJson(path.join(packageDir, 'review-package-v3-complete.json'), reviewPackage);
const bytes = fs.readFileSync(path.join(packageDir, 'review-package-v3-complete.json'));
process.stdout.write(`${JSON.stringify({ reviewPackage: path.join(packageDir, 'review-package-v3-complete.json'), reviewPackageSha256: sha(bytes), candidateSha: bound.candidateSha, helperManifestSha256: reviewPackage.helperManifestSha256, files: records.length, runtimePayloadFiles: payloadRows.length, sourceTestFiles: chosen.sourceTestFileCount })}\n`);
