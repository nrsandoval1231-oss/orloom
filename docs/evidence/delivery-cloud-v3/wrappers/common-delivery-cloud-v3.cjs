const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const work = __dirname;
const root = path.join(work, 'c3-delivery-cloud-v3');
const helpers = path.join(root, 'helpers');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeNewJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
function binding() {
  const file = path.join(root, 'source-binding-v3.json');
  if (!fs.existsSync(file)) fail('Frozen source-binding.json is required after final independent source review');
  const value = readJson(file);
  if (value.format !== 'orloom-c3-delivery-cloud-source-binding-v1') fail('Unexpected source binding format');
  for (const [key, pattern] of Object.entries({ candidateSha: /^[a-f0-9]{40}$/, baseSha: /^[a-f0-9]{40}$/, sourceManifestSha256: /^[a-f0-9]{64}$/, sourceReviewSha256: /^[a-f0-9]{64}$/, sourceReviewAdmissionSha256: /^[a-f0-9]{64}$/ })) {
    if (!pattern.test(value[key] || '')) fail(`Invalid source binding field: ${key}`);
  }
  if (value.sourceRef !== 'refs/heads/feat/certified-delivery') fail('Only the approved certified-delivery ref is accepted');
  if (path.resolve(value.sourceRepo || '') !== path.resolve(work, 'orloom-delivery')) fail('Source repository must be the configured work/orloom-delivery checkout');
  if (path.resolve(value.sourceReviewFile || '') !== path.resolve(root, 'source-review-v3.json')) fail('Source review must be copied into the candidate package directory');
  const reviewBytes = fs.readFileSync(value.sourceReviewFile);
  if (sha(reviewBytes) !== value.sourceReviewSha256) fail('Source review digest differs from frozen binding');
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const acceptedRawVerdicts = new Set(['PASS', 'PASS_SOURCE', 'PASS_SOURCE_BOUNDED']);
  if (!acceptedRawVerdicts.has(review.verdict) || review.candidateSha !== value.candidateSha || review.baseSha !== value.baseSha || review.sourceRef !== value.sourceRef || review.sourceManifestSha256 !== value.sourceManifestSha256) {
    fail('Raw final independent review is not an accepted source verdict for the exact candidate, base, ref, and manifest');
  }
  const admissionFile = path.join(root, 'source-review-admission-v3.json');
  const admissionBytes = fs.readFileSync(admissionFile);
  if (sha(admissionBytes) !== value.sourceReviewAdmissionSha256) fail('Normalized source-review admission digest differs');
  const admission = JSON.parse(admissionBytes.toString('utf8'));
  const expectedAdmissionKeys = ['format', 'normalizedVerdict', 'rawVerdict', 'candidateSha', 'baseSha', 'sourceRef', 'sourceManifestSha256', 'sourceReviewSha256'].sort();
  if (Object.keys(admission).sort().join('|') !== expectedAdmissionKeys.join('|') || admission.format !== 'orloom-c3-delivery-cloud-source-review-admission-v1' || admission.normalizedVerdict !== 'PASS' || admission.rawVerdict !== review.verdict || admission.candidateSha !== value.candidateSha || admission.baseSha !== value.baseSha || admission.sourceRef !== value.sourceRef || admission.sourceManifestSha256 !== value.sourceManifestSha256 || admission.sourceReviewSha256 !== value.sourceReviewSha256) {
    fail('Normalized source-review admission is not an exact PASS envelope for the retained raw review');
  }
  return { ...value, sourceReview: review, sourceReviewAdmission: admission, sourceReviewAdmissionSha256: sha(admissionBytes) };
}
function candidateDir(bound = binding()) { return path.join(root, 'candidate-' + bound.candidateSha.slice(0, 12) + '-v3'); }
function readHelperManifest(expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) fail('Exact independently reviewed helper-manifest SHA-256 is required');
  const bytes = fs.readFileSync(path.join(helpers, 'helper-manifest-v3.json'));
  if (sha(bytes) !== expected) fail('Helper manifest digest differs from independent review');
  const manifest = JSON.parse(bytes.toString('utf8'));
  const bound = binding();
  if (manifest.candidateSha !== bound.candidateSha || manifest.sourceManifestSha256 !== bound.sourceManifestSha256 || manifest.sourceReviewSha256 !== bound.sourceReviewSha256 || manifest.sourceReviewAdmissionSha256 !== bound.sourceReviewAdmissionSha256) fail('Helper manifest is bound to a different source review');
  for (const item of manifest.files) {
    const helper = path.join(helpers, item.file), transfer = path.join(candidateDir(bound), 'transfer', item.file);
    if (sha(fs.readFileSync(helper)) !== item.sha256 || sha(fs.readFileSync(transfer)) !== item.sha256) fail(`Helper digest mismatch: ${item.file}`);
  }
  return { bound, manifest, helperManifestSha256: expected };
}
function selected(bound = binding()) {
  const file = path.join(candidateDir(bound), 'selected-transfer.json');
  if (!fs.existsSync(file)) fail('Prepared candidate transfer is missing');
  const value = readJson(file);
  if (value.candidateSha !== bound.candidateSha || value.baseSha !== bound.baseSha || value.sourceRef !== bound.sourceRef || value.sourceManifestSha256 !== bound.sourceManifestSha256) fail('Prepared transfer identity differs from frozen binding');
  return value;
}
function verifyRuntimePayload(chosen) {
  const payload = path.join(chosen.transfer, 'runtime-files');
  const manifestBytes = fs.readFileSync(path.join(payload, 'runtime-files.sha256'));
  if (sha(manifestBytes) !== chosen.runtimePayloadManifestSha256) fail('Runtime payload manifest SHA-256 differs from selected transfer');
  const rows = manifestBytes.toString('utf8').trimEnd().split('\n');
  for (const row of rows) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
    if (!match) fail('Malformed runtime payload manifest row');
    const relative = match[2].replaceAll('\\', '/');
    if (relative.startsWith('/') || relative.split('/').includes('..')) fail('Unsafe runtime payload path');
    const file = path.join(payload, ...relative.split('/'));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(fs.readFileSync(file)) !== match[1]) fail(`Runtime payload content differs: ${relative}`);
  }
  return { payload, manifestBytes, rows };
}
function verifyReviewPackageFiles(review) {
  if (!Array.isArray(review.files)) fail('Preparation review package file inventory is missing');
  const base = work;
  for (const item of review.files) {
    if (!item || typeof item.file !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) fail('Malformed preparation review package inventory');
    const file = path.resolve(base, item.file);
    const relative = path.relative(base, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('Preparation review path escapes the work directory');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(fs.readFileSync(file)) !== item.sha256) fail(`Reviewed package file changed: ${item.file}`);
  }
}
function assertFileSha(file, expected, label) {
  if (sha(fs.readFileSync(file)) !== expected) fail(`${label} digest mismatch`);
}

module.exports = { work, root, helpers, sha, fail, readJson, writeNewJson, binding, candidateDir, readHelperManifest, selected, verifyRuntimePayload, verifyReviewPackageFiles, assertFileSha };
