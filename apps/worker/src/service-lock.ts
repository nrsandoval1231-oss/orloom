import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** A Linux flock is held by this process's open file description, including
 * after the short flock subprocess exits. Kernel process teardown releases it.
 * The protected operator-provisioned lock is outside the strict journal root. */
export async function acquireWorkerServiceLock(file = '/var/lib/orloom/worker-service.lock'): Promise<{ release(): Promise<void> }> {
  if (process.platform !== 'linux' || !path.isAbsolute(file)) throw new Error('Worker lifetime lock requires Linux and an absolute path');
  const parent = await lstat(path.dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() || (parent.mode & 0o022) !== 0) throw new Error('Worker lock parent must be operator-owned and not writable by others');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid!() || (before.mode & 0o077) !== 0 || await realpath(file) !== path.resolve(file)) throw new Error('Worker lifetime lock must be a private operator-owned regular file');
  const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino) throw new Error('Worker lifetime lock changed while opening');
    const result = spawnSync('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', handle.fd], timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    if (result.error || result.status !== 0) throw new Error('Another broker owns the worker runtime service');
    return { async release() { await handle.close(); } };
  } catch (error) { await handle.close(); throw error; }
}
