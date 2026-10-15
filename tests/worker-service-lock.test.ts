import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as lock from '../apps/worker/src/service-lock.js';

test('Linux broker lifetime lock refuses a concurrent owner and releases for restart', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orloom-lock-'));
  try {
    const file = path.join(root, 'service.lock');
    await writeFile(file, '', { mode: 0o600 });
    const first = await lock.acquireWorkerServiceLock(file);
    await assert.rejects(lock.acquireWorkerServiceLock(file));
    await first.release();
    const restart = await lock.acquireWorkerServiceLock(file);
    await restart.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
test('kernel releases broker lock after process interruption, allowing restart reconciliation', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orloom-lock-crash-'));
  const file = path.join(root, 'service.lock');
  await writeFile(file, '', { mode: 0o600 });
  const module = new URL('../apps/worker/src/service-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireWorkerServiceLock} from ${JSON.stringify(module)}; const lock=await acquireWorkerServiceLock(${JSON.stringify(file)}); process.stdout.write('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('lock child did not become ready')), 5000); t.unref(); })]);
    await assert.rejects(lock.acquireWorkerServiceLock(file));
    const stopped = once(child, 'close'); child.kill('SIGKILL'); await stopped;
    const recovered = await lock.acquireWorkerServiceLock(file); await recovered.release();
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
