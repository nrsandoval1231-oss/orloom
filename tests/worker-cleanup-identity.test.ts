import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupOwnedContainer, DockerWorkerRuntime, ownershipLabels, reconcileInterruptedWorkers } from '../apps/worker/src/docker-runtime.js';
import { FileRuntimeJournal, ownershipLabelsDigest } from '../apps/worker/src/runtime-journal.js';
import type { WorkerLeaseContract } from '../packages/contracts/src/worker-protocol.js';

const exec = promisify(execFile);
const id = 'b'.repeat(64);
const imageRef = `sha256:${'a'.repeat(64)}`;
const name = 'orloom-worker-proof';
const labels = ownershipLabels(name, 1);

for (const mismatch of ['image', 'name', 'wrong-id', 'missing-label', 'extra-owned-label', 'local-image-id'] as const) {
  test(`cleanup refuses ${mismatch} mismatch without removal`, async () => {
    let removals = 0;
    const current = { id: mismatch === 'wrong-id' ? 'c'.repeat(64) : id,
      labels: mismatch === 'extra-owned-label' ? { ...labels, 'com.orloom.foreign': 'true' } : mismatch === 'missing-label' ? { ...labels, 'com.orloom.instance': undefined } as unknown as Record<string, string> : { ...labels, 'org.orloom.source': 'inherited' },
      imageRef: mismatch === 'image' ? `sha256:${'f'.repeat(64)}` : imageRef,
      imageId: mismatch === 'local-image-id' ? `sha256:${'f'.repeat(64)}` : imageRef,
      name: mismatch === 'name' ? '/renamed-foreign' : `/${name}` };
    const control = { async inspect() { return removals ? null : current; }, async remove() { removals++; } };
    await assert.rejects(cleanupOwnedContainer(control, id, labels, { name, imageRef }), /identity|ownership/);
    assert.equal(removals, 0);
  });
}

test('cleanup and reconciliation accept inherited org.orloom metadata', async () => {
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'orloom-inherited-label-'));
  try {
    const journal = await FileRuntimeJournal.openPortableTestRoot(journalRoot);
    const identity = { missionId: 'mission', sliceId: 'slice', leaseEpoch: 1, controllerRunId: 'c'.repeat(8) };
    const labelsWithMetadata = { ...labels, 'org.orloom.source': 'base-image' };
    const labelsDigest = ownershipLabelsDigest(labels);
    await journal.recordIntent({ identity, name, imageRef, labelsDigest });
    await journal.recordCreated(identity, id, labelsDigest);
    let removed = false;
    const control = {
      async inspect() { return removed ? null : { id, labels: labelsWithMetadata, imageRef, imageId: imageRef, name: `/${name}` }; },
      async remove() { removed = true; },
    };
    await cleanupOwnedContainer(control, id, labels, { name, imageRef });
    assert.equal(removed, true);
    removed = false;
    const outcomes = await reconcileInterruptedWorkers(journal, control);
    assert.deepEqual(outcomes.map(row => row.outcome), ['absent']);
    assert.equal(removed, true);
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
});

test('Docker launch accepts inherited org.orloom source metadata and records, starts, and cleans the owned container', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orloom-inherited-launch-'));
  try {
    const fixture = path.join(root, 'fixture'), journalRoot = path.join(root, 'journal'), scratch = path.join(root, 'scratch');
    await mkdir(fixture); await mkdir(journalRoot, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
    await exec('git', ['init', fixture]);
    await writeFile(path.join(fixture, 'README.md'), 'disposable fixture\n');
    await exec('git', ['-C', fixture, 'add', 'README.md']);
    await exec('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const baseSha = (await exec('git', ['-C', fixture, 'rev-parse', 'HEAD'])).stdout.trim();
    const fakeDocker = path.join(root, 'fake-docker'), trace = path.join(root, 'trace.jsonl'), state = path.join(root, 'container.json');
    await writeFile(fakeDocker, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const a=process.argv.slice(2).slice(4), op=a[0], state=${JSON.stringify(state)}, trace=${JSON.stringify(trace)}, id=${JSON.stringify(id)};
fs.appendFileSync(trace,JSON.stringify(a)+'\\n');
if(op==='create') {
 const labels=Object.fromEntries(a.filter(x=>x.startsWith('--label=')).map(x=>{const v=x.slice(8),i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
 labels['org.orloom.source']='base-image';
 const name=a.find(x=>x.startsWith('--name=')).slice(7), image=a.at(-2);
 fs.writeFileSync(state,JSON.stringify({Id:id,Image:image,Name:'/'+name,Config:{Image:image,Labels:labels},State:{Running:false}})); console.log(id);
} else if(op==='inspect') {
 if(!fs.existsSync(state)){console.error('Error: No such object: '+a.at(-1));process.exit(1);}
 console.log(fs.readFileSync(state,'utf8'));
} else if(op==='rm') fs.rmSync(state,{force:true});
else if(op==='start') {
 for await (const line of readline.createInterface({input:process.stdin})) {
  const request=JSON.parse(line); fs.appendFileSync(trace,JSON.stringify({rpc:request.op})+'\\n');
  process.stdout.write(JSON.stringify({id:request.id,ok:true,value:{initialized:true}})+'\\n');
 }
}
`, { mode: 0o700 });
    const journal = await FileRuntimeJournal.openOperational(journalRoot);
    const lease = { protocol: 'orloom.worker-lease.v1', mission: { id: 'mission', repository: 'fixture/repo', baseSha, objective: 'fixture', acceptance: ['accept inherited image metadata'] }, slice: { id: 'slice', checks: [], objective: 'fixture', scopes: ['src/**'], dependencies: [], owner: 'fixture' }, leaseEpoch: 1, planDigest: 'e'.repeat(64), trustedCheckPolicyDigest: 'f'.repeat(64), capacitySlot: 1, leaseToken: 'fixture', capabilityToken: 'fixture', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ['fixture'], allowedModels: ['fixture'] } } satisfies WorkerLeaseContract;
    const runtime = new DockerWorkerRuntime({ imageRef, installationId: 1, checkoutTokens: { async createCheckoutToken() { throw new Error('no credentials allowed'); } }, checkoutTransport: { async fetchExact(input) { await input.fetch(fixture); } }, checks: {}, scratchRoot: scratch, dockerPath: fakeDocker, runtimeJournal: journal });
    const workspace = await runtime.create(lease);
    await workspace.checkout('fixture/repo', baseSha);
    await workspace.close();
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[] | { rpc: string });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'start'), true, 'valid inherited metadata reaches Docker start');
    assert.equal(calls.some(call => !Array.isArray(call) && call.rpc === 'init'), true, 'sandbox RPC initializes');
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'rm'), true, 'owned container is removed on clean close');
    assert.deepEqual((await journal.unresolved()), [], 'recordCreated is reconciled to absent');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// These subprocess responses simulate the Docker CLI, not Docker/runsc isolation.
for (const failure of ['inspection', 'lost-create-reply', 'invalid-create-id'] as const) {
  for (const mismatch of ['image', 'name', 'extra-owned-label', 'local-image-id'] as const) {
    test(`launch ${failure} preserves ${mismatch} mismatch as UNKNOWN without removal`, { skip: process.platform !== 'linux' }, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'orloom-identity-'));
      try {
        const fixture = path.join(root, 'fixture'), journalRoot = path.join(root, 'journal'), scratch = path.join(root, 'scratch');
        await mkdir(fixture); await mkdir(journalRoot, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
        await exec('git', ['init', fixture]);
        await writeFile(path.join(fixture, 'README.md'), 'disposable fixture\n');
        await exec('git', ['-C', fixture, 'add', 'README.md']);
        await exec('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
        const baseSha = (await exec('git', ['-C', fixture, 'rev-parse', 'HEAD'])).stdout.trim();
        const fakeDocker = path.join(root, 'fake-docker'), trace = path.join(root, 'trace.jsonl'), state = path.join(root, 'container.json');
        await writeFile(fakeDocker, `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2).slice(4), op=a[0], state=${JSON.stringify(state)};
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');
if(op==='create') {
  const labels=Object.fromEntries(a.filter(x=>x.startsWith('--label=')).map(x=>{const v=x.slice(8),i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
  if(${JSON.stringify(mismatch)}==='extra-owned-label') labels['com.orloom.foreign']='true';
  fs.writeFileSync(state,JSON.stringify({Id:${JSON.stringify(id)},Image:${JSON.stringify(mismatch === 'local-image-id' ? `sha256:${'f'.repeat(64)}` : imageRef)},Config:{Image:${JSON.stringify(mismatch === 'image' ? `sha256:${'f'.repeat(64)}` : imageRef)},Labels:labels},Name:${JSON.stringify(mismatch)}==='name'?'/renamed-foreign':'/'+a.find(x=>x.startsWith('--name=')).slice(7),State:{Running:false}}));
  if(${JSON.stringify(failure)}==='lost-create-reply') process.exit(1);
  console.log(${JSON.stringify(failure === 'invalid-create-id' ? 'invalid' : id)});
} else if(op==='inspect') { if(fs.existsSync(state)) console.log(fs.readFileSync(state,'utf8')); else {console.error('Error: No such object: '+a.at(-1));process.exit(1);} }
else if(op==='rm') fs.rmSync(state,{force:true});
else if(op==='start') {console.error('UNEXPECTED START');process.exit(9);}
`, { mode: 0o700 });
        const journal = await FileRuntimeJournal.openOperational(journalRoot);
        const lease = { protocol: 'orloom.worker-lease.v1', mission: { id: 'mission', repository: 'fixture/repo', baseSha, objective: 'fixture', acceptance: ['retain mismatched identity'] }, slice: { id: 'slice', checks: [], objective: 'fixture', scopes: ['src/**'], dependencies: [], owner: 'fixture' }, leaseEpoch: 1, planDigest: 'e'.repeat(64), trustedCheckPolicyDigest: 'f'.repeat(64), capacitySlot: 1, leaseToken: 'fixture', capabilityToken: 'fixture', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ['fixture'], allowedModels: ['fixture'] } } satisfies WorkerLeaseContract;
        const runtime = new DockerWorkerRuntime({ imageRef, installationId: 1, checkoutTokens: { async createCheckoutToken() { throw new Error('no credentials allowed'); } }, checkoutTransport: { async fetchExact(input) { await input.fetch(fixture); } }, checks: {}, scratchRoot: scratch, dockerPath: fakeDocker, runtimeJournal: journal });
        const workspace = await runtime.create(lease);
        await assert.rejects(workspace.checkout('fixture/repo', baseSha));
        await assert.rejects(workspace.close(), /UNKNOWN/);
        const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
        assert.equal(calls.some(call => call[0] === 'rm'), false, 'identity mismatch must not authorize removal');
        assert.equal(calls.some(call => call[0] === 'start'), false);
        assert.equal((await journal.unresolved())[0]?.state, 'unknown');
        assert.equal(JSON.parse(await readFile(state, 'utf8')).Id, id, 'mismatched container is retained');
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
