import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Creates three independent commits in a fresh disposable object store. It never
// writes refs or objects to the source checkout.
const exec = promisify(execFile);
const sha = b => createHash('sha256').update(b).digest('hex');
const source = path.resolve(process.env.ORLOOM_ACCEPTANCE_SOURCE_REPO ?? '../orloom-suite');
const candidate = process.env.ORLOOM_ACCEPTANCE_CANDIDATE_SHA;
const baseSha = process.env.ORLOOM_ACCEPTANCE_BASE_SHA;
const sourceRef = process.env.ORLOOM_ACCEPTANCE_SOURCE_REF ?? 'refs/heads/feat/trusted-verification-suite';
const root = path.resolve(process.env.ORLOOM_ACCEPTANCE_FIXTURE_ROOT ?? 'fixtures');
assert.match(candidate ?? '', /^[a-f0-9]{40}$/);
assert.match(baseSha ?? '', /^[a-f0-9]{40}$/);
assert.match(sourceRef, /^refs\/heads\/[A-Za-z0-9._/-]+$/);
const git = async (cwd, args) => (await exec('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'C3 proof fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'C3 proof fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' } })).stdout.trim();
assert.equal(await git(source, ['rev-parse', 'HEAD']), candidate, 'source checkout is not the frozen candidate');
assert.equal(await git(source, ['rev-parse', `${sourceRef}^{commit}`]), candidate, 'source ref does not name the frozen candidate');
assert.equal(await git(source, ['status', '--porcelain=v1']), '', 'source checkout must be clean');
try { await stat(root); throw new Error('fixture root already exists; refusing overwrite'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await mkdir(root, { recursive: false, mode: 0o700 });
const bare = path.join(root, 'objects.git'), scratch = path.join(root, 'scratch');
await git(root, ['init', '--bare', '--initial-branch=candidate', bare]);
await git(root, ['--git-dir', bare, 'fetch', '--no-tags', source, candidate]);
await git(root, ['--git-dir', bare, 'update-ref', 'refs/heads/candidate', candidate]);
await git(root, ['--git-dir', bare, 'merge-base', '--is-ancestor', baseSha, candidate]);
await git(root, ['clone', bare, scratch]);
await git(scratch, ['checkout', '-B', 'candidate', candidate]);

const fixtures = {};
for (const [name, file, contents, message] of [
  ['failing', 'tests/c3-proof-failure.test.ts', 'import { test } from "node:test";\ntest("controlled C3 proof failure", () => { throw new Error("C3_PROOF_EXPECTED_FAILURE"); });\n', 'fixture: real failing repository test'],
  ['lockMismatch', 'package-lock.json', null, 'fixture: dependency lock byte mismatch'],
  ['hanging', 'tests/c3-proof-hang.test.ts', 'import test from "node:test";\ntest("controlled C3 proof hang", () => { for (;;) {} });\n', 'fixture: actual test process hang'],
]) {
  await git(scratch, ['reset', '--hard', candidate]);
  if (name === 'lockMismatch') {
    const lock = await readFile(path.join(scratch, file));
    await writeFile(path.join(scratch, file), Buffer.concat([lock, Buffer.from(' ') ]));
  } else {
    await mkdir(path.dirname(path.join(scratch, file)), { recursive: true });
    await writeFile(path.join(scratch, file), contents, { flag: 'wx' });
  }
  await git(scratch, ['add', '--', file]);
  const tree = await git(scratch, ['diff', '--cached', '--name-only']);
  assert.equal(tree, file, `${name} fixture changed an unexpected path`);
  await git(scratch, ['commit', '-m', message]);
  const commit = await git(scratch, ['rev-parse', 'HEAD']);
  await git(root, ['--git-dir', bare, 'fetch', '--no-tags', scratch, `${commit}:refs/heads/proof-${name}`]);
  assert.equal(await git(root, ['--git-dir', bare, 'merge-base', candidate, commit]), candidate, `${name} fixture must descend from frozen source candidate`);
  fixtures[name] = { commit, parent: candidate, changedPath: file };
}
const output = { format: 'orloom-c3-suite-acceptance-fixtures-v1', baseSha, sourceCandidate: candidate, sourceRef, objectStore: bare, approvedRef: 'refs/heads/candidate', fixtures };
const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
await writeFile(path.join(root, 'fixtures.json'), bytes, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...output, fixtureFileSha256: sha(bytes) })}\n`);
