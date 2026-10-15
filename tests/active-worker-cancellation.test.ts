import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as runtime from '../apps/worker/src/docker-runtime.js';
import { FileRuntimeJournal, ownershipLabelsDigest } from '../apps/worker/src/runtime-journal.js';

const identity = { missionId: 'mission', sliceId: 'slice', leaseEpoch: 1, controllerRunId: 'd'.repeat(64) };
const name = 'orloom-worker-1-proof';
const imageRef = `sha256:${'a'.repeat(64)}`;
const id = 'b'.repeat(64);
const labels = runtime.ownershipLabels(name, 1);

test('trusted cancellation reconciler exists', () => {
  assert.equal(typeof (runtime as Record<string, unknown>).reconcileInterruptedWorkers, 'function');
});

for (const scenario of ['removed', 'daemon-down', 'wrong-label', 'wrong-image', 'wrong-name', 'still-present', 'remove-error-but-absent', 'unbound-intent'] as const) {
  test(`restart reconciliation: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orloom-cancel-'));
    try {
      const journal = await FileRuntimeJournal.openOperational(root);
      await journal.recordIntent({ identity, name, imageRef, labelsDigest: ownershipLabelsDigest(labels) });
      if (scenario !== 'unbound-intent') await journal.recordCreated(identity, id, ownershipLabelsDigest(labels));
      let present = true, removals = 0;
      const control = {
        async inspect(query: string) {
          if (scenario === 'daemon-down') throw new Error('daemon unavailable');
          if (!present) return null;
          return { id, labels: scenario === 'wrong-label' ? {} : labels, imageRef: scenario === 'wrong-image' ? `sha256:${'f'.repeat(64)}` : imageRef, name: scenario === 'wrong-name' ? '/foreign' : `/${name}`, running: true };
        },
        async remove(query: string) {
          assert.equal(query, id);
          removals++;
          if (scenario !== 'still-present') present = false;
          if (scenario === 'remove-error-but-absent') throw new Error('lost reply');
        }
      };
      const reconcile = (runtime as unknown as { reconcileInterruptedWorkers: (journal: FileRuntimeJournal, control: runtime.DockerContainerControl) => Promise<Array<{ outcome: string }>> }).reconcileInterruptedWorkers;
      const outcomes = await reconcile(journal, control);
      const absent = ['removed', 'remove-error-but-absent'].includes(scenario);
      assert.equal(outcomes[0]?.outcome, absent ? 'absent' : 'unknown');
      assert.equal(removals, ['removed', 'remove-error-but-absent', 'still-present'].includes(scenario) ? 1 : 0);
      const reopened = await FileRuntimeJournal.openOperational(root);
      assert.equal((await reopened.unresolved()).length, absent ? 0 : 1);
      await reconcile(reopened, control); // repeated requests are safe, never launch anything
      if (absent) assert.equal(removals, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

import { HttpControlPlane } from '../packages/agents/src/worker.js';
import * as worker from '../packages/agents/src/worker.js';
import type { WorkerLeaseContract } from '../packages/contracts/src/worker-protocol.js';
const lease = { mission: { id: 'mission' }, slice: { id: 'slice' }, leaseEpoch: 1, leaseToken: 'lease', capabilityToken: 'cap' } as WorkerLeaseContract;

test('HTTP worker cancellation poll binds both credentials and exact epoch', async () => {
  const control = new HttpControlPlane('https://control.example', 'bootstrap', async (url, init) => {
    assert.equal(String(url), 'https://control.example/api/worker/missions/mission/slices/slice/cancellation');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string,string>).authorization, 'Bearer cap');
    assert.equal((init?.headers as Record<string,string>)['x-orloom-lease-token'], 'lease');
    assert.equal((init?.headers as Record<string,string>)['x-orloom-lease-epoch'], '1');
    return Response.json({ requested: true });
  });
  const poll = (control as unknown as { cancellationRequested(lease: WorkerLeaseContract): Promise<boolean> }).cancellationRequested;
  assert.equal(typeof poll, 'function');
  assert.equal(await poll.call(control, lease), true);
});

for (const mode of ['cancel', 'unavailable'] as const) {
  test(`running cancellation monitor aborts on ${mode} and does not resume`, async () => {
    const controller = new AbortController();
    let polls = 0;
    const control = { async cancellationRequested() { polls++; if (mode === 'unavailable') throw new Error('network'); return polls > 1; } };
    const monitor = (worker as unknown as { monitorCancellation(control: { cancellationRequested(): Promise<boolean> }, lease: WorkerLeaseContract, controller: AbortController, intervalMs: number): { ready: Promise<void>; stop(): Promise<void> } }).monitorCancellation;
    assert.equal(typeof monitor, 'function');
    const watch = monitor(control, lease, controller, 5);
    await watch.ready;
    if (!controller.signal.aborted) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('monitor did not abort')), 1000);
      controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    await watch.stop();
    assert.equal(controller.signal.aborted, true);
    assert.equal(polls, mode === 'cancel' ? 2 : 1);
  });
}

import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('cancellation during durable create binding never starts the sandbox subprocess (simulated Docker CLI)', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orloom-launch-race-'));
  try {
    const fixture = path.join(root, 'fixture'), journalRoot = path.join(root, 'journal'), scratch = path.join(root, 'scratch');
    await mkdir(fixture); await mkdir(journalRoot, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
    await exec('git', ['init', fixture]);
    await writeFile(path.join(fixture, 'README.md'), 'disposable mission\n');
    await exec('git', ['-C', fixture, 'add', 'README.md']);
    await exec('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const baseSha = (await exec('git', ['-C', fixture, 'rev-parse', 'HEAD'])).stdout.trim();
    const fakeDocker = path.join(root, 'fake-docker');
    const trace = path.join(root, 'trace.jsonl');
    const state = path.join(root, 'container.json');
    // Explicitly a protocol fixture, not an isolated Docker runtime.
    await writeFile(fakeDocker, `#!${process.execPath}\nimport fs from 'node:fs';
const a=process.argv.slice(2).slice(4); const op=a[0];
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');
const state=${JSON.stringify(state)};
if(op==='create') { const labels=Object.fromEntries(a.filter(x=>x.startsWith('--label=')).map(x=>{const v=x.slice(8);const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));fs.writeFileSync(state,JSON.stringify({Id:${JSON.stringify(id)},Config:{Image:${JSON.stringify(imageRef)},Labels:labels},Name:'/'+a.find(x=>x.startsWith('--name=')).slice(7),State:{Running:false}}));console.log(${JSON.stringify(id)}); }
else if(op==='inspect'){if(fs.existsSync(state)) console.log(fs.readFileSync(state,'utf8')); else {console.error('Error: No such object: '+a.at(-1));process.exit(1);} }
else if(op==='rm') {fs.rmSync(state,{force:true});}
else if(op==='start'){console.error('UNEXPECTED START');process.exit(9);}
`, { mode: 0o700 });
    const journal = await FileRuntimeJournal.openOperational(journalRoot);
    const controller = new AbortController();
    const journalWithRace = {
      recordIntent: journal.recordIntent.bind(journal),
      async recordCreated(...args: Parameters<typeof journal.recordCreated>) { await journal.recordCreated(...args); controller.abort(); },
      recordAbsent: journal.recordAbsent.bind(journal), recordUnknown: journal.recordUnknown.bind(journal), unresolved: journal.unresolved.bind(journal)
    };
    const actualLease = { ...lease, protocol: 'orloom.worker-lease.v1', mission: { ...lease.mission, repository: 'fixture/repo', baseSha }, slice: { ...lease.slice, checks: [] }, planDigest: 'e'.repeat(64), trustedCheckPolicyDigest: 'f'.repeat(64) } as WorkerLeaseContract;
    const sandbox = new runtime.DockerWorkerRuntime({ imageRef, installationId: 1, checkoutTokens: { async createCheckoutToken() { throw new Error('must not request credentials'); } }, checkoutTransport: { async fetchExact(input) { await input.fetch(fixture); } }, checks: {}, scratchRoot: scratch, dockerPath: fakeDocker, runtimeJournal: journalWithRace });
    const workspace = await sandbox.create(actualLease);
    await assert.rejects(workspace.checkout('fixture/repo', baseSha, controller.signal), /cancelled before start/);
    await workspace.close();
    const calls = (await (await import('node:fs/promises')).readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(calls.some(call => call[0] === 'start'), false);
    assert.equal((await journal.unresolved()).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
