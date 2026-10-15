import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic owner-readiness browser proof. It exercises the real HTTP server
// and MemoryMissionStore, but never starts a worker, provider, verifier, or runtime.
const source = resolve(process.argv[2] ?? '.');
const output = resolve(process.argv[3] ?? join(source, 'work/owner-readiness-browser'));
const load = file => import(pathToFileURL(join(source, 'dist', file)).href);
const { createControlPlane } = await load('apps/control-plane/src/server.js');
const { MemoryJobStore } = await load('packages/contracts/src/memory-store.js');
const { MemoryMissionStore } = await load('packages/contracts/src/memory-mission-store.js');
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? 'C:/Users/nrsan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const { chromium } = require(playwrightPath);
await mkdir(output, { recursive: true });

const token = randomBytes(32).toString('base64url');
const store = new MemoryMissionStore();
const mission = await store.submit({ repository: 'orloom/owner-readiness-fixture', baseSha: 'a'.repeat(40), objective: 'Synthetic readiness and cancellation browser fixture', acceptance: ['Render stored mission state'], budgetCents: 100 });
const checks = ['synthetic-check-v1'];
await store.recommendPlan(mission.id, [{ id: 'fixture-slice', objective: 'Controlled browser fixture', owner: 'fixture', dependencies: [], scopes: ['fixture'], checks, budgetCents: 100 }], 'synthetic-browser-harness');
await store.approvePlan(mission.id);
const policyDigest = createHash('sha256').update(JSON.stringify(checks)).digest('hex');
await store.configureCapacity(1, createHash('sha256').update('synthetic-capacity-evidence').digest('hex'), new Date(Date.now() + 300_000).toISOString());
const grant = await store.claim(300, policyDigest, checks);
assert(grant, 'synthetic fixture must acquire a lease before cancellation');

const config = {
  mode: 'local', port: 0, sessionToken: token, workerToken: randomBytes(32).toString('base64url'),
  maxLanes: 1, capacitySlots: 1, capacityEvidenceDigest: createHash('sha256').update('synthetic-capacity-evidence').digest('hex'),
  capacityEvidenceExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  trustedCheckPolicy: checks, trustedCheckPolicyDigest: policyDigest,
  workerMaxProviderCalls: 0, workerMaxInputTokens: 0, workerMaxOutputTokens: 0, workerMaxWallSeconds: 0,
  workerAllowedProviders: [], workerAllowedModels: [],
};
let server;
const startServer = async (serverConfig = config) => {
  server = createControlPlane(serverConfig, new MemoryJobStore(), store, undefined, serverConfig === readyConfig ? {} : undefined);
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address(); assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
};
const readyConfig = {
  ...config,
  workerMaxProviderCalls: 1, workerMaxInputTokens: 1000, workerMaxOutputTokens: 1000, workerMaxWallSeconds: 30,
  workerAllowedProviders: ['synthetic-fixture'], workerAllowedModels: ['synthetic-fixture-model'],
  trustedVerifierId: 'synthetic-verifier-fixture', trustedVerifierImageDigest: 'f'.repeat(64), trustedVerificationPolicyVersion: 'synthetic-policy-v1',
};
let origin = await startServer();
const url = `${origin}/loom?mission=${encodeURIComponent(mission.id)}`;
const results = { fixture: 'synthetic-memory-store', workerExecutions: 0, providerCalls: 0, runtimeStarts: 0, certificates: 0, errors: [], requests: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => results.errors.push(error.message));
  page.on('request', request => { const parsed = new URL(request.url()); results.requests.push({ method: request.method(), path: parsed.pathname }); });

  await page.goto(url);
  const denied = await context.request.get(`${origin}/api/missions/${mission.id}/loom`);
  assert.equal(denied.status(), 401, 'mission evidence requires owner authentication');
  assert.equal(await page.locator('#readiness-state').innerText(), 'Readiness unavailable');
  results.unauthenticated = 'owner session required; readiness unavailable';

  const login = await context.request.post(`${origin}/session`, { data: { token } });
  assert.equal(login.status(), 204);
  await page.reload();
  await page.waitForFunction(() => ['Live connection', 'Evidence connected'].includes(document.querySelector('#live')?.textContent), null, { timeout: 4000 });
  await page.waitForFunction(() => document.querySelector('#readiness-state')?.textContent !== 'Readiness unavailable', null, { timeout: 4000 });
  const initialProjection = await context.request.get(`${origin}/api/missions/${mission.id}/loom`);
  assert.equal(initialProjection.status(), 200);
  const live = await initialProjection.json();
  assert(['unavailable', 'unverified', 'ready'].includes(live.projection?.readiness?.state));
  assert.equal(live.projection.readiness.configuration.mode, 'local');
  assert.equal(live.projection.readiness.state, 'unverified', 'zero execution/provider configuration cannot render ready');
  assert.equal((await page.locator('#readiness-state').innerText()).toLowerCase().includes('unverified'), true);
  results.readiness = live.projection.readiness;
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });

  // Cancellation is requested through the real authenticated HTTP API, then
  // the store records an exact lease-epoch pre-runtime settlement out of band.
  const requested = await context.request.post(`${origin}/api/missions/${mission.id}/cancel`, { data: { ownerRequestId: 'browser-proof-cancel', reason: 'synthetic fixture cancellation' } });
  assert.equal(requested.status(), 202);
  const identity = { missionId: mission.id, sliceId: grant.slice.id, leaseEpoch: grant.epoch, controllerRunId: createHash('sha256').update(`synthetic:${mission.id}:${grant.epoch}`).digest('hex') };
  assert.equal(await store.settleCancellationBeforeRuntime(identity), 'settled');
  await page.locator('#refresh-desktop').click();
  await page.waitForFunction(() => document.querySelector('#events-desktop')?.textContent?.includes('Cancelled before runtime start'), null, { timeout: 4000 });
  await browser.close(); browser = null;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  origin = await startServer();
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const recoveredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const recoveredPage = await recoveredContext.newPage();
  recoveredPage.on('pageerror', error => results.errors.push(error.message));
  recoveredPage.on('request', request => { const parsed = new URL(request.url()); results.requests.push({ method: request.method(), path: parsed.pathname }); });
  await recoveredPage.goto(`${origin}/loom?mission=${encodeURIComponent(mission.id)}`);
  assert.equal((await recoveredContext.request.post(`${origin}/session`, { data: { token } })).status(), 204);
  await recoveredPage.reload();
  await recoveredPage.waitForFunction(() => ['Live connection', 'Evidence connected'].includes(document.querySelector('#live')?.textContent), null, { timeout: 4000 });
  await recoveredPage.waitForFunction(() => document.querySelector('#events-desktop')?.textContent?.includes('Cancelled before runtime start'), null, { timeout: 4000 });
  const afterSettlement = await recoveredContext.request.get(`${origin}/api/missions/${mission.id}/loom`);
  const recovered = await afterSettlement.json();
  assert.equal(recovered.projection.cancellation.state, 'pre-runtime-settled');
  assert(recovered.projection.cancellation.slices.some(slice => slice.sliceId === grant.slice.id && slice.leaseEpoch === grant.epoch && slice.state === 'pre-runtime-settled'));
  assert(recovered.projection.events.some(event => event.type === 'slice.cancellation_settled_before_runtime' && event.sliceId === grant.slice.id));
  results.cancellation = recovered.projection.cancellation;
  results.recoveryEvent = 'slice.cancellation_settled_before_runtime';

  // Separate, explicitly synthetic bound-runtime UNKNOWN fixture: write the
  // actual store binding, expire that lease, request cancellation over HTTP,
  // then feed an exact retained UNKNOWN observation. No runtime is launched.
  const unknownMission = await store.submit({ repository: 'orloom/owner-readiness-unknown-fixture', baseSha: 'b'.repeat(40), objective: 'Synthetic bound-runtime UNKNOWN fixture', acceptance: ['Retain unresolved state'], budgetCents: 100 });
  await store.recommendPlan(unknownMission.id, [{ id: 'unknown-slice', objective: 'Controlled unresolved fixture', owner: 'fixture', dependencies: [], scopes: ['fixture-unknown'], checks, budgetCents: 100 }], 'synthetic-browser-harness');
  await store.approvePlan(unknownMission.id);
  const unknownGrant = await store.claim(300, policyDigest, checks);
  assert(unknownGrant, 'first pre-runtime settlement must free the fixture capacity slot');
  const unknownIdentity = { missionId: unknownMission.id, sliceId: unknownGrant.slice.id, leaseEpoch: unknownGrant.epoch, controllerRunId: createHash('sha256').update(`synthetic-bound-unknown:${unknownMission.id}:${unknownGrant.epoch}`).digest('hex') };
  const binding = { name: 'orloom-worker-slice', imageRef: `sha256:${'d'.repeat(64)}`, labelsDigest: createHash('sha256').update('synthetic-bound-labels').digest('hex') };
  const containerId = 'e'.repeat(64);
  await store.registerCancellationRuntimeBinding(unknownIdentity, binding);
  await store.bindCancellationRuntimeContainer(unknownIdentity, containerId);
  await store.expire(new Date(Date.now() + 301_000));
  assert.equal((await store.getMission(unknownMission.id)).slices[0].status, 'unknown');
  assert.equal((await recoveredContext.request.post(`${origin}/api/missions/${unknownMission.id}/cancel`, { data: { ownerRequestId: 'browser-proof-unknown-cancel', reason: 'retain bound runtime uncertainty' } })).status(), 202);
  const observedAt = new Date().toISOString();
  const observation = { source: 'orloom.trusted-docker-reconciler.v1', outcome: 'unknown', identity: unknownIdentity, ...binding, containerId, observedAt };
  const unknownEntry = { version: 'orloom.runtime-journal.v2', identity: unknownIdentity, ...binding, containerId, state: 'unknown', updatedAt: observedAt, reconciliation: observation, history: [{ state: 'intent', at: observedAt }, { state: 'created', at: observedAt, containerId }, { state: 'unknown', at: observedAt, observation }] };
  assert.equal(await store.reconcileCancellationRuntime(unknownEntry), 'quarantined');
  const unknownRead = await (await recoveredContext.request.get(`${origin}/api/missions/${unknownMission.id}/loom`)).json();
  assert.equal(unknownRead.projection.state, 'UNKNOWN');
  assert.equal(unknownRead.projection.cancellation.state, 'quarantined-unknown');
  assert(unknownRead.projection.cancellation.slices.some(slice => slice.sliceId === unknownGrant.slice.id && slice.leaseEpoch === unknownGrant.epoch && slice.state === 'quarantined-unknown'));
  assert(!unknownRead.projection.events.some(event => event.type.includes('settled') && event.sliceId === unknownGrant.slice.id), 'UNKNOWN reconciliation must not create a settlement event');
  results.boundUnknown = { state: unknownRead.projection.cancellation.state, sliceId: unknownGrant.slice.id, leaseEpoch: unknownGrant.epoch, settlementEvent: false, fixture: 'synthetic-memory-store-binding; no runtime process or container was started' };

  await recoveredPage.goto(`${origin}/loom?mission=${encodeURIComponent(unknownMission.id)}`);
  await recoveredPage.waitForFunction(() => document.querySelector('#live')?.textContent?.includes('UNKNOWN'), null, { timeout: 4000 });
  await recoveredPage.waitForFunction(() => document.querySelector('#cancellation-desktop')?.textContent?.toLowerCase().includes('unknown'), null, { timeout: 4000 });
  await recoveredPage.setViewportSize({ width: 390, height: 844 });
  await recoveredPage.locator('#inspect').evaluate(element => { element.open = true; });
  await recoveredPage.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
  results.mobileOverflow = await recoveredPage.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(results.mobileOverflow, false);
  await recoveredContext.setOffline(true);
  await recoveredPage.locator('#refresh').click();
  await recoveredPage.waitForFunction(() => document.querySelector('#live')?.textContent?.includes('Disconnected'), null, { timeout: 4000 });
  await recoveredPage.waitForFunction(() => document.querySelector('#readiness-state')?.textContent === 'Readiness unavailable', null, { timeout: 4000 });
  results.offlineReadiness = await recoveredPage.locator('#readiness-state').innerText();
  assert.match(await recoveredPage.locator('#live').innerText(), /Disconnected/i);
  await recoveredPage.screenshot({ path: join(output, 'offline-history.png'), fullPage: true });
  await recoveredContext.setOffline(false);
  await recoveredPage.locator('#refresh').click();
  await recoveredPage.waitForFunction(() => document.querySelector('#live')?.textContent?.includes('UNKNOWN') && document.querySelector('#notice')?.textContent?.includes('durable UNKNOWN'), null, { timeout: 4000 });
  const reconnected = await (await recoveredContext.request.get(`${origin}/api/missions/${unknownMission.id}/loom`)).json();
  assert.deepEqual(reconnected.projection.events.map(event => [event.cursor, event.type]), unknownRead.projection.events.map(event => [event.cursor, event.type]));
  assert.equal(reconnected.projection.cancellation.state, unknownRead.projection.cancellation.state);
  results.reconnectedSameEvents = true;

  // Exercise the READY prerequisites state against another real loopback
  // server with explicit synthetic configuration and an unused authority stub.
  const readyMission = await store.submit({ repository: 'orloom/owner-readiness-ready-fixture', baseSha: 'c'.repeat(40), objective: 'Synthetic ready prerequisites fixture', acceptance: ['Inspect configured prerequisites'], budgetCents: 100 });
  await store.recommendPlan(readyMission.id, [{ id: 'ready-slice', objective: 'Controlled ready fixture', owner: 'fixture', dependencies: [], scopes: ['fixture-ready'], checks, budgetCents: 100 }], 'synthetic-browser-harness');
  await store.approvePlan(readyMission.id);
  await browser.close(); browser = null;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  origin = await startServer(readyConfig);
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const readyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const readyPage = await readyContext.newPage();
  readyPage.on('pageerror', error => results.errors.push(error.message));
  readyPage.on('request', request => { const parsed = new URL(request.url()); results.requests.push({ method: request.method(), path: parsed.pathname }); });
  await readyPage.goto(`${origin}/loom?mission=${encodeURIComponent(readyMission.id)}`);
  assert.equal((await readyContext.request.post(`${origin}/session`, { data: { token } })).status(), 204);
  await readyPage.reload();
  await readyPage.waitForFunction(() => ['Live connection', 'Evidence connected'].includes(document.querySelector('#live')?.textContent), null, { timeout: 4000 });
  const readyRead = await (await readyContext.request.get(`${origin}/api/missions/${readyMission.id}/loom`)).json();
  assert.equal(readyRead.projection.readiness.state, 'ready');
  assert.equal(readyRead.projection.readiness.liveExecution, 'unverified');
  assert.equal(await readyPage.locator('#readiness-state').innerText(), 'Prerequisites ready');
  assert.match(await readyPage.locator('#readiness-details').innerText(), /Live execution: unverified/);
  await readyPage.screenshot({ path: join(output, 'ready-prerequisites.png'), fullPage: true });
  results.readyPrerequisites = { state: readyRead.projection.readiness.state, liveExecution: readyRead.projection.readiness.liveExecution, fixture: 'synthetic configuration and unused authority stub' };

  assert.equal(results.errors.length, 0);
  assert(results.requests.filter(item => item.path.startsWith('/api/')).every(item => item.method === 'GET'));
  results.status = 'PASS_SYNTHETIC_BROWSER';
} catch (error) {
  results.status = 'FAIL'; results.error = error.message;
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  await writeFile(join(output, 'result.json'), JSON.stringify({ ...results, finishedUtc: new Date().toISOString(), limitations: ['MemoryMissionStore is process-local; reload reconstruction is not a PostgreSQL durability proof', 'Capacity digest and runtime binding/container identity are explicit synthetic fixtures; no worker, provider, runtime, certificate, integration, or delivery activity occurred', 'READY records configured prerequisites only; no live worker/provider success is asserted'] }, null, 2));
  console.log(JSON.stringify({ status: results.status, evidence: output }));
}
