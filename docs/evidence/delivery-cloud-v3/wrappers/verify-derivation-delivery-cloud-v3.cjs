const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { root, sha, fail, binding, candidateDir, selected, writeNewJson } = require('./common-delivery-cloud-v3.cjs');

const bound = binding(), packageDir = candidateDir(bound), chosen = selected(bound);
const source = bound.sourceRepo, output = path.join(packageDir, 'fresh-compile');
const git = (...args) => cp.execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
if (git('rev-parse', 'HEAD') !== bound.candidateSha || git('status', '--porcelain=v1')) fail('Exact clean source candidate is required');
if (fs.existsSync(output)) fail('Fresh compile output exists; refuse overwrite');
fs.mkdirSync(output, { recursive: false, mode: 0o700 });
const startedUtc = new Date().toISOString();
const result = cp.spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--outDir', output], { cwd: source, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
fs.writeFileSync(path.join(output, 'build.log'), `${result.stdout || ''}${result.stderr || ''}`, { flag: 'wx', mode: 0o600 });
if (result.status !== 0) fail(`Fresh TypeScript build failed (${result.status ?? result.signal})`);

const payload = path.join(chosen.transfer, 'runtime-files');
const payloadManifestBytes = fs.readFileSync(path.join(payload, 'runtime-files.sha256'));
if (sha(payloadManifestBytes) !== chosen.runtimePayloadManifestSha256) fail('Runtime payload manifest differs from selected transfer');
const rows = payloadManifestBytes.toString('utf8').trimEnd().split('\n');
const compiledFiles = [], dependencyFiles = [], migrationFiles = [];
for (const row of rows) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
  if (!match) fail('Malformed runtime payload inventory row');
  const [, expected, relative] = match;
  if (relative === 'package.json') continue;
  if (relative.startsWith('node_modules/')) {
    if (sha(fs.readFileSync(path.join(source, relative))) !== expected) fail(`Locked dependency bytes differ: ${relative}`);
    dependencyFiles.push(relative);
    continue;
  }
  if (relative.startsWith('dist/') && relative.endsWith('.js')) {
    const actual = sha(fs.readFileSync(path.join(output, relative.slice(5))));
    if (actual !== expected) fail(`Fresh compile differs from packaged module: ${relative}`);
    compiledFiles.push({ file: relative, sha256: actual });
    continue;
  }
  if (relative.startsWith('db/migrations/') && relative.endsWith('.sql')) {
    const actual = sha(fs.readFileSync(path.join(source, relative)));
    if (actual !== expected) fail(`Candidate migration differs from payload: ${relative}`);
    migrationFiles.push({ file: relative, sha256: actual });
    continue;
  }
  fail(`Unexpected runtime payload path: ${relative}`);
}
const derivation = {
  format: 'orloom-c3-delivery-cloud-derivation-v1', status: 'PASS',
  candidateSha: bound.candidateSha, baseSha: bound.baseSha, sourceRef: bound.sourceRef,
  sourceManifestSha256: bound.sourceManifestSha256, sourceReviewSha256: bound.sourceReviewSha256,
  helperManifestSha256: chosen.helperManifestSha256,
  runtimePayloadManifestSha256: chosen.runtimePayloadManifestSha256,
  startedUtc, finishedUtc: new Date().toISOString(),
  compilerCommand: ['node', 'node_modules/typescript/bin/tsc', '--outDir', output],
  compiledFiles, dependencyFileCount: dependencyFiles.length, dependencyPackageCount: chosen.runtimeDependencyPackageCount,
  dependencyRoots: chosen.runtimeDependencyRoots,
  optionalDependencyExclusions: chosen.runtimeOptionalDependencyExclusions,
  dependencyProvenance: 'Bytes match the frozen candidate installed tree and package-lock dependency closure; registry integrity was not re-verified.',
  migrations: migrationFiles, hostExecution: false,
};
writeNewJson(path.join(packageDir, 'derivation.json'), derivation);
process.stdout.write(`${JSON.stringify({ status: derivation.status, candidateSha: derivation.candidateSha, compiledFiles: compiledFiles.length, dependencyFiles: dependencyFiles.length, migrations: migrationFiles.length })}\n`);
