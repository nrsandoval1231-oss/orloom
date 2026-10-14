import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const reviewedSourceHead = '8f271de796e643a3a0b9b47b80fc1de3e3646d9d';
export const fixtureAttemptWallBudgetSeconds = 300;
export const reviewedFixtureBundle = 'c7733fd7d49035516e8d1ef0868c8412236f3f3fb2ba41237c77db7abe71ecb2';
export const reviewedFixtureCommits = Object.freeze({ episodeAFail: '8f3d929db36949c496a14361cc26fc0f4eb58681', episodeAPass: '67a12c1262c23eafc785b30b99e31ba7b55b36aa', episodeBFail: '1283a32c192ab448b00ff160d48a76c4c870bd1e', episodeBPass: 'fb21a4623352ae61eae3951d14997801204d3fcc', laterFail: '2eacfb2f628a1d0592edc764cf115ff8652a3503' });

export function verifyFixtureBinding(fixture, bundleBytes) {
  assert.equal(fixture.sourceHead, reviewedSourceHead);
  assert.deepEqual(fixture.commits, reviewedFixtureCommits);
  assert.equal(fixture.bundleSha256, reviewedFixtureBundle);
  assert.equal(sha(bundleBytes), reviewedFixtureBundle);
}

export async function verifyRuntimePayload(root, expectedDigest) {
  const identity = JSON.parse(await readFile(path.join(root, 'runtime-files-identity.json'), 'utf8'));
  assert.equal(identity.format, 'orloom-c1b-runtime-payload-v1');
  assert.equal(identity.candidate, reviewedSourceHead); assert.equal(identity.cleanBuild, true);
  const manifest = await readFile(path.join(root, 'runtime-files.sha256'));
  assert.equal(sha(manifest), identity.payloadManifestSha256);
  assert.equal(sha(manifest), expectedDigest, 'runtime payload differs from controller-reviewed clean-build manifest');
  const rows = manifest.toString('utf8').trimEnd().split('\n');
  assert.equal(identity.fileCount, rows.length);
  const expected = new Set(['runtime-files.sha256', 'runtime-files-identity.json']);
  for (const line of rows) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(match, 'invalid runtime payload inventory row');
    const relative = match[2]; assert.ok(!relative.includes('\\') && !path.posix.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe runtime payload path');
    assert.ok(!expected.has(relative), 'duplicate runtime payload path'); expected.add(relative);
    const file = path.join(root, ...match[2].split('/')), st = await lstat(file);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(sha(await readFile(file)), match[1], `runtime payload file hash mismatch: ${match[2]}`);
  }
  const actual = new Set();
  const visit = async (directory, prefix = '') => {
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), relative = path.posix.join(prefix, name), st = await lstat(file);
      assert.ok(!st.isSymbolicLink());
      if (st.isDirectory()) await visit(file, relative);
      else if (st.isFile()) actual.add(relative);
      else throw new Error('unexpected runtime payload entry type');
    }
  };
  await visit(root);
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'runtime payload contains unmanifested or missing files');
  return identity;
}

export function armRequestDeadline(request, milliseconds) {
  const timer = setTimeout(() => request.destroy(new Error('bounded request timeout')), milliseconds);
  request.once('close', () => clearTimeout(timer));
  return timer;
}

export function elapsedMilliseconds(startedMonotonic, finishedMonotonic) {
  assert.ok(Number.isFinite(startedMonotonic) && Number.isFinite(finishedMonotonic) && finishedMonotonic >= startedMonotonic);
  return Math.ceil(finishedMonotonic - startedMonotonic);
}

export function assertPersistedWallTime(progress, measuredWallMs) {
  assert.equal(progress.counters.wallMs, measuredWallMs, 'persisted progress wall counter differs from the measured trusted-attempt interval');
  assert.ok(Number.isSafeInteger(progress.counters.wallMs) && progress.counters.wallMs >= 0);
}

export function assertWallTimeWithinBudget(measuredWallMs, budgetSeconds) {
  assert.ok(Number.isSafeInteger(measuredWallMs) && measuredWallMs >= 0);
  assert.ok(Number.isFinite(budgetSeconds) && budgetSeconds > 0);
  assert.ok(measuredWallMs <= budgetSeconds * 1000, 'trusted attempt exceeded its configured finite wall-time budget');
}
