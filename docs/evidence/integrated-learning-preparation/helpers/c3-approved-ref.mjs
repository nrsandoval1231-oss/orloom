import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Explicit controller-only CAS recovery. Caller must supply observed negative and certified SHAs. */
export async function restoreCertifiedApprovedRef({ objectStore, approvedRef, expectedNegativeSha, certifiedSha, binding, activation }) {
  assert.ok(objectStore && approvedRef && binding && activation);
  assert.match(expectedNegativeSha ?? '', /^[a-f0-9]{40}$/);
  assert.match(certifiedSha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(certifiedSha, binding.runtimeSha, 'restore target must be the certificate-bound integrated runtime');
  assert.match(approvedRef, /^refs\/heads\/[A-Za-z0-9._/-]+$/);
  assert.ok(!approvedRef.includes('..'), 'approved ref contains a forbidden path segment');
  assert.notEqual(expectedNegativeSha, certifiedSha, 'compare-and-swap must move from a distinct observed negative head');
  const store = await realpath(objectStore);
  const run = async (...args) => (await exec('git', args, { windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  assert.equal(await run('--git-dir', store, 'rev-parse', '--is-bare-repository'), 'true');
  const before = await run('--git-dir', store, 'rev-parse', approvedRef);
  assert.equal(before, expectedNegativeSha, 'approved ref moved since the controller observed the negative result');
  await run('--git-dir', store, 'update-ref', approvedRef, certifiedSha, expectedNegativeSha);
  assert.equal(await run('--git-dir', store, 'rev-parse', approvedRef), certifiedSha);
  await activation.assertAccepted();
  return Object.freeze({ approvedRef, previousSha: expectedNegativeSha, restoredSha: certifiedSha, certificateRequeried: true });
}
