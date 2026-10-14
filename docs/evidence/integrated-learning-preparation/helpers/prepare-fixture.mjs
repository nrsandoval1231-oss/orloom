import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewedHead = '8f271de796e643a3a0b9b47b80fc1de3e3646d9d';
const required = ['ORLOOM_C1B_SOURCE_ROOT', 'ORLOOM_C1B_BASE_SHA', 'ORLOOM_C1B_FIXTURE_OUTPUT'];
for (const key of required) assert.ok(process.env[key], `${key} is required`);
const sourceRoot = await realpath(process.env.ORLOOM_C1B_SOURCE_ROOT);
const outputRoot = path.resolve(process.env.ORLOOM_C1B_FIXTURE_OUTPUT);
const baseSha = process.env.ORLOOM_C1B_BASE_SHA;
assert.match(baseSha, /^[a-f0-9]{40}$/);
assert.ok(path.isAbsolute(outputRoot));
const rel = path.relative(sourceRoot, outputRoot);
assert.ok(rel === '..' || rel.startsWith(`..${path.sep}`), 'fixture output must be outside the source checkout');
const run = async (cwd, args, extra = {}) => (await exec('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...extra } })).stdout.trim();
const sourceHead = await run(sourceRoot, ['rev-parse', 'HEAD']);
assert.equal(sourceHead, reviewedHead, 'fixture preparation is pinned to the reviewed source head');
assert.equal(baseSha, sourceHead, 'fixture base must be the exact integrated runtime source SHA');
assert.equal(await run(sourceRoot, ['status', '--porcelain=v1']), '', 'source checkout must be clean before fixture preparation');
assert.equal(await run(sourceRoot, ['rev-parse', `${baseSha}^{commit}`]), baseSha, 'base SHA must resolve exactly');
assert.equal(await run(sourceRoot, ['merge-base', '--is-ancestor', baseSha, 'HEAD']).then(() => true), true, 'reviewed C1b base must be reachable from source checkout');
await mkdir(outputRoot, { recursive: false, mode: 0o700 });
const objectStore = path.join(outputRoot, 'fixture.git'), scratch = path.join(outputRoot, 'fixture-work'), approvedRef = 'refs/heads/orloom-c1b-runtime-proof';
await run(path.dirname(outputRoot), ['clone', '--bare', '--no-hardlinks', sourceRoot, objectStore]);
// The reviewed checkout contains long retained-evidence filenames. Enable Git for Windows long-path handling
// only in this disposable fixture clone so preparation does not change host or user Git configuration.
await run(sourceRoot, ['--git-dir', objectStore, 'config', 'core.longpaths', 'true']);
await run(sourceRoot, ['--git-dir', objectStore, 'worktree', 'add', '--detach', scratch, baseSha]);
await run(scratch, ['config', 'user.name', 'Orloom C1b Runtime Fixture']);
await run(scratch, ['config', 'user.email', 'c1b-runtime-fixture@invalid.local']);
const sourceFile = path.join(scratch, 'scripts', 'validate.mjs');
const original = await readFile(sourceFile);
const invalid = Buffer.concat([original, Buffer.from('\nconst c1bIntentionalSyntaxFailure = ;\n')]);
const put = async bytes => writeFile(sourceFile, bytes, { flag: 'w', mode: 0o600 });
const commitTimes = {
  'episode-a-fail': '2026-10-13T13:26:07-05:00', 'episode-a-pass': '2026-10-13T13:26:08-05:00',
  'episode-b-fail': '2026-10-13T13:26:08-05:00', 'episode-b-pass': '2026-10-13T13:26:08-05:00',
  'later-contradiction': '2026-10-13T13:26:08-05:00',
};
const commit = async (label, bytes) => {
  await put(bytes); await run(scratch, ['add', '--', 'scripts/validate.mjs']);
  await run(scratch, ['commit', '--quiet', '-m', `C1b runtime fixture ${label}`], { GIT_AUTHOR_DATE: commitTimes[label], GIT_COMMITTER_DATE: commitTimes[label] });
  return run(scratch, ['rev-parse', 'HEAD']);
};
const failA = await commit('episode-a-fail', invalid);
const passA = await commit('episode-a-pass', original);
const failB = await commit('episode-b-fail', invalid);
const passB = await commit('episode-b-pass', original);
const laterFail = await commit('later-contradiction', invalid);
// Verify the fail/pass commit contents independently before exporting the bundle.
for (const [sha, expected] of [[failA, 1], [passA, 0], [failB, 1], [passB, 0], [laterFail, 1]]) {
  const bytes = Buffer.from(await run(sourceRoot, ['--git-dir', objectStore, 'show', `${sha}:scripts/validate.mjs`]));
  const tmp = path.join(outputRoot, `syntax-${sha}.mjs`); await writeFile(tmp, bytes, { flag: 'wx', mode: 0o400 });
  const actual = await exec(process.execPath, ['--check', tmp], { windowsHide: true }).then(() => 0, e => Number(e.code));
  assert.equal(actual, expected, `fixture commit ${sha} did not produce the intended syntax-check result`);
}
await run(sourceRoot, ['--git-dir', objectStore, 'update-ref', approvedRef, laterFail]);
const bundlePath = path.join(outputRoot, 'fixture.bundle');
await run(sourceRoot, ['--git-dir', objectStore, 'bundle', 'create', bundlePath, approvedRef]);
const bundleSha256 = sha(await readFile(bundlePath));
const fixture = {
  format: 'orloom-c1b-runtime-fixture-v1', sourceHead, baseSha, repository: 'fixture/orloom', approvedRef,
  targetCheckId: 'node-validate-syntax', checkId: 'node-validate-syntax',
  commits: { episodeAFail: failA, episodeAPass: passA, episodeBFail: failB, episodeBPass: passB, laterFail },
  bundleSha256, fixturePath: 'scripts/validate.mjs', intendedExitCodes: { fail: 1, pass: 0 },
  note: 'Only the isolated syntax-check fixture file differs from the exact reviewed source base; no product source was edited.'
};
await writeFile(path.join(outputRoot, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
await run(sourceRoot, ['--git-dir', objectStore, 'worktree', 'remove', '--force', scratch]);
process.stdout.write(JSON.stringify({ status: 'PREPARED_LOCAL_FIXTURE', baseSha, candidateShas: Object.values(fixture.commits), bundleSha256, fixtureRoot: outputRoot }) + '\n');
