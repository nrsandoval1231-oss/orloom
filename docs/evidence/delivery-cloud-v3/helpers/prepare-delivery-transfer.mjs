import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path.resolve(process.env.ORLOOM_DELIVERY_SOURCE_REPO ?? '../orloom-delivery');
const runtime = path.resolve(process.env.ORLOOM_DELIVERY_RUNTIME_FILES ?? 'runtime-files');
const output = path.resolve(process.env.ORLOOM_DELIVERY_TRANSFER_DIR ?? 'transfer');
const candidate = process.env.ORLOOM_DELIVERY_CANDIDATE_SHA, base = process.env.ORLOOM_DELIVERY_BASE_SHA;
const sourceRef = process.env.ORLOOM_DELIVERY_SOURCE_REF;
const sourceManifestSha = process.env.ORLOOM_DELIVERY_SOURCE_MANIFEST_SHA256;
const runGit = async (...args) => (await exec('git', args, {
  cwd: source,
  windowsHide: true,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
})).stdout.trim();
assert.equal(await runGit('rev-parse', 'HEAD'), candidate);
assert.equal(await runGit('rev-parse', `${sourceRef}^{commit}`), candidate);
assert.equal(await runGit('status', '--porcelain=v1'), '');
await runGit('merge-base', '--is-ancestor', base, candidate);
const sourceManifest = await readFile(path.join(source, '.agent/ORL-C3-SUITE-MANIFEST.sha256'));
assert.equal(sha(sourceManifest), sourceManifestSha);
const runtimeIdentity = JSON.parse(await readFile(path.join(runtime, 'runtime-files-identity.json'), 'utf8'));
assert.equal(runtimeIdentity.candidate, candidate);
assert.equal(runtimeIdentity.base, base);
assert.equal(runtimeIdentity.sourceRef, sourceRef);
assert.equal(runtimeIdentity.sourceManifestSha256, sourceManifestSha);
const runtimeManifest = await readFile(path.join(runtime, 'runtime-files.sha256'));
assert.equal(sha(runtimeManifest), runtimeIdentity.payloadManifestSha256);
try {
  await lstat(output);
  throw new Error('transfer output exists; refusing overwrite');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(output, { mode: 0o700 });
const bundle = path.join(output, 'candidate.bundle');
await exec('git', ['bundle', 'create', bundle, sourceRef], { cwd: source, windowsHide: true });
const bundleHeads = (await exec('git', ['bundle', 'list-heads', bundle], { cwd: source, windowsHide: true })).stdout.trim();
assert.equal(bundleHeads, `${candidate} ${sourceRef}`, 'bundle must expose exactly the approved candidate ref');
await exec('git', ['bundle', 'verify', bundle], { cwd: source, windowsHide: true });
await cp(runtime, path.join(output, 'runtime-files'), { recursive: true, errorOnExist: true, force: false });
const identity = {
  format: 'orloom-c3-delivery-cloud-transfer-v1', candidateSha: candidate,
  baseSha: base, sourceRef, sourceManifestSha256: sourceManifestSha,
  sourceManifestFileCount: sourceManifest.toString('utf8').trimEnd().split('\n').length,
  bundleSha256: sha(await readFile(bundle)),
  runtimePayloadManifestSha256: runtimeIdentity.payloadManifestSha256,
  runtimeFileCount: runtimeIdentity.fileCount,
  migrationCount: runtimeIdentity.migrationCount,
  compiledJsCount: runtimeIdentity.compiledJsCount,
};
await writeFile(path.join(output, 'candidate-identity.json'), `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
process.stdout.write(`${JSON.stringify(identity)}\n`);
