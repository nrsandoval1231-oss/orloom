import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewedBundle = 'c7733fd7d49035516e8d1ef0868c8412236f3f3fb2ba41237c77db7abe71ecb2';
const reviewedCommits = { episodeAFail: '8f3d929db36949c496a14361cc26fc0f4eb58681', episodeAPass: '67a12c1262c23eafc785b30b99e31ba7b55b36aa', episodeBFail: '1283a32c192ab448b00ff160d48a76c4c870bd1e', episodeBPass: 'fb21a4623352ae61eae3951d14997801204d3fcc', laterFail: '2eacfb2f628a1d0592edc764cf115ff8652a3503' };
const required = ['ORLOOM_C1B_FIXTURE_FILE', 'ORLOOM_C1B_FIXTURE_BUNDLE', 'ORLOOM_C1B_OBJECT_STORE', 'ORLOOM_C1B_SOURCE_ROOT', 'ORLOOM_VERIFIER_ARTIFACT_ROOT'];
for (const key of required) assert.ok(process.env[key], `${key} is required`);
const fixture = JSON.parse(await readFile(process.env.ORLOOM_C1B_FIXTURE_FILE, 'utf8'));
const bundlePath = await realpath(process.env.ORLOOM_C1B_FIXTURE_BUNDLE);
const bundle = await readFile(bundlePath);
assert.equal(fixture.format, 'orloom-c1b-runtime-fixture-v1');
assert.equal(fixture.sourceHead, '8f271de796e643a3a0b9b47b80fc1de3e3646d9d');
assert.equal(fixture.baseSha, '8f271de796e643a3a0b9b47b80fc1de3e3646d9d');
assert.equal(fixture.repository, 'fixture/orloom');
assert.equal(fixture.approvedRef, 'refs/heads/orloom-c1b-runtime-proof');
assert.equal(fixture.fixturePath, 'scripts/validate.mjs');
assert.deepEqual(Object.keys(fixture.commits).sort(), ['episodeAFail', 'episodeAPass', 'episodeBFail', 'episodeBPass', 'laterFail'].sort());
assert.deepEqual(fixture.commits, reviewedCommits, 'fixture commits differ from the immutable reviewed map');
assert.ok(Object.values(fixture.commits).every(value => /^[a-f0-9]{40}$/.test(value)));
assert.equal(fixture.bundleSha256, reviewedBundle, 'fixture manifest differs from the independent bundle pin');
assert.equal(sha(bundle), reviewedBundle, 'fixture bundle digest differs from the independent pin');
const objectStore = path.resolve(process.env.ORLOOM_C1B_OBJECT_STORE);
assert.ok(path.isAbsolute(process.env.ORLOOM_C1B_OBJECT_STORE) && path.isAbsolute(process.env.ORLOOM_C1B_SOURCE_ROOT) && path.isAbsolute(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT));
const sourceRoot = await realpath(process.env.ORLOOM_C1B_SOURCE_ROOT), artifactRoot = await realpath(process.env.ORLOOM_VERIFIER_ARTIFACT_ROOT);
const within = (parent, candidate) => { const rel = path.relative(parent, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const overlaps = (a, b) => within(a, b) || within(b, a);
assert.ok(!overlaps(sourceRoot, objectStore) && !overlaps(artifactRoot, objectStore) && !overlaps(sourceRoot, artifactRoot), 'source, object-store and artifact roots must be separate');
const parent = path.dirname(objectStore);
await mkdir(parent, { recursive: true, mode: 0o700 });
await assert.rejects(lstat(objectStore), error => error?.code === 'ENOENT');
const run = async (...args) => (await exec('git', args, {
  windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
})).stdout.trim();
await run('init', '--bare', objectStore);
await run('--git-dir', objectStore, 'config', 'core.longpaths', 'true');
const refspec = `+${fixture.approvedRef}:${fixture.approvedRef}`;
await run('--git-dir', objectStore, 'fetch', '--no-tags', bundlePath, refspec);
assert.equal(await run('--git-dir', objectStore, 'rev-parse', fixture.approvedRef), fixture.commits.laterFail);
for (const shaValue of [fixture.baseSha, ...Object.values(fixture.commits)]) {
  assert.equal(await run('--git-dir', objectStore, 'cat-file', '-t', shaValue), 'commit');
  await run('--git-dir', objectStore, 'merge-base', '--is-ancestor', fixture.baseSha, shaValue);
}
let expectedParent = fixture.baseSha;
for (const shaValue of [fixture.commits.episodeAFail, fixture.commits.episodeAPass, fixture.commits.episodeBFail, fixture.commits.episodeBPass, fixture.commits.laterFail]) {
  const row = (await run('--git-dir', objectStore, 'rev-list', '--parents', '-n', '1', shaValue)).split(/\s+/);
  assert.deepEqual(row, [shaValue, expectedParent], 'fixture commit parent chain differs from reviewed order');
  assert.equal(await run('--git-dir', objectStore, 'diff-tree', '--no-commit-id', '--name-only', '-r', shaValue), 'scripts/validate.mjs');
  const bytes = await exec('git', ['--git-dir', objectStore, 'show', `${shaValue}:scripts/validate.mjs`], { encoding: 'buffer', windowsHide: true });
  const tmp = path.join(path.dirname(objectStore), `c1b-check-${shaValue}.mjs`);
  await (await import('node:fs/promises')).writeFile(tmp, bytes.stdout, { flag: 'wx', mode: 0o400 });
  const expected = [fixture.commits.episodeAFail, fixture.commits.episodeBFail, fixture.commits.laterFail].includes(shaValue) ? 1 : 0;
  const actual = await exec(process.execPath, ['--check', tmp], { windowsHide: true }).then(() => 0, e => Number(e.code));
  await (await import('node:fs/promises')).unlink(tmp);
  assert.equal(actual, expected, `fixture syntax outcome changed for ${shaValue}`);
  expectedParent = shaValue;
}
process.stdout.write(`${JSON.stringify({ status: 'FIXTURE_INSTALLED', bundleSha256: fixture.bundleSha256, approvedRef: fixture.approvedRef, commitCount: Object.keys(fixture.commits).length, objectStore })}\n`);
