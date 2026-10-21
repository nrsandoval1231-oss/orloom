import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { runApprovedWorkerLane } from "../apps/control-plane/src/approved-worker-lane.js";
import { runApprovedWorkerService } from "../apps/worker/src/approved-service.js";
import { controllerRunIdFor } from "../apps/worker/src/docker-runtime.js";
import { HttpControlPlane, type WorkerOptions } from "../packages/agents/src/worker.js";
import { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { LifecycleStoppedError } from "../packages/contracts/src/lifecycle.js";
import type { RuntimeJournal, RuntimeJournalEntry } from "../apps/worker/src/runtime-journal.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const timeout = async <T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};

test("authenticated owner HTTP cancellation aborts the approved service's held checkout without paid or candidate effects", async () => {
  const model = "fixture-model";
  const checks = ["check:unit"];
  const policyDigest = hash(JSON.stringify(checks));
  const imageRef = `sha256:${"d".repeat(64)}`;
  const store = new MemoryMissionStore();
  await store.configureCapacity(1, hash("fixture-capacity"), new Date(Date.now() + 300_000).toISOString());
  const ownerToken = "owner-http-cancel-fixture";
  const config = {
    mode: "local" as const, port: 0, sessionToken: ownerToken, workerToken: "worker-bootstrap-fixture",
    maxLanes: 1, capacitySlots: 1, trustedCheckPolicy: checks, trustedCheckPolicyDigest: policyDigest,
    workerMaxProviderCalls: 1, workerMaxInputTokens: 10_000, workerMaxOutputTokens: 64, workerMaxWallSeconds: 30,
    workerAllowedProviders: ["deepseek"], workerAllowedModels: [model],
  };
  const server = createControlPlane(config, new MemoryJobStore(), store);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let baseUrl = "";
  const remoteRequests: string[] = [];
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, "127.0.0.1", `unexpected non-loopback fetch: ${url.hostname}`);
    remoteRequests.push(url.pathname);
    return fetch(input, init);
  };
  let ownerCookie: string | undefined;
  let missionId: string | undefined;
  let checkoutReachedResolve!: () => void;
  let abortedResolve!: () => void;
  let pollResolve!: () => void;
  const checkoutReached = new Promise<void>(resolve => { checkoutReachedResolve = resolve; });
  const checkoutAborted = new Promise<void>(resolve => { abortedResolve = resolve; });
  const cancellationPollSeen = new Promise<void>(resolve => { pollResolve = resolve; });
  let probeToolsCalls = 0, completionCalls = 0, candidateCommits = 0, workspaceCloses = 0, integrations = 0;
  let modelListFakeCalls = 0, ownerCancellationCalls = 0;
  const evidenceObjects = new Map<string, Uint8Array>();
  const evidence = {
    async put(bytes: Uint8Array) { const copy = new Uint8Array(bytes); const digest = hash(copy); const key = `sha256/${digest}`; evidenceObjects.set(key, copy); return { key, sha256: digest }; },
    async get(key: string) { const value = evidenceObjects.get(key); assert(value); return new Uint8Array(value); },
  };
  const provider = {
    async listModels() { modelListFakeCalls++; return [model]; },
    async probeTools() { probeToolsCalls++; throw new Error("forbidden fake paid probe reached"); },
    async complete() { completionCalls++; throw new Error("forbidden fake paid completion reached"); },
  };
  const options: WorkerOptions = {
    allowedModels: [model], allowedProviders: ["deepseek"], trustedChecks: checks, trustedCheckPolicyDigest: policyDigest,
    trustedCheckCommands: { "check:unit": { executable: "node", args: ["fixture"], timeoutSeconds: 10 } },
    sandboxImageRef: imageRef, maxToolCalls: 1,
    pricing: { model, version: "fixture-v1", source: "test-only", capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), inputCentsPerMillion: 1, outputCentsPerMillion: 1, reasoningCentsPerMillion: 1, safetyMultiplier: 1.25 },
  };
  const journalEntries = new Map<string, RuntimeJournalEntry>();
  const runtimeJournal: RuntimeJournal = {
    async recordIntent(input) {
      const identityKey = `${input.identity.missionId}:${input.identity.sliceId}:${input.identity.leaseEpoch}`;
      const at = new Date().toISOString();
      journalEntries.set(identityKey, { version: "orloom.runtime-journal.v2", ...input, containerId: null, state: "intent", updatedAt: at, reconciliation: null, history: [{ state: "intent", at }] });
    },
    async recordCreated(identity, containerId, labelsDigest) {
      const key = `${identity.missionId}:${identity.sliceId}:${identity.leaseEpoch}`;
      const prior = journalEntries.get(key); assert(prior); const at = new Date().toISOString();
      journalEntries.set(key, { ...prior, containerId, state: "created", updatedAt: at, history: [...prior.history, { state: "created", at, containerId }] });
      assert.equal(prior.labelsDigest, labelsDigest);
    },
    async recordUnknown() { throw new Error("fake journal never fabricates reconciliation"); },
    async recordAbsent() { throw new Error("fake journal never fabricates absence"); },
    async unresolved() { return [...journalEntries.values()].filter(entry => entry.state === "intent" || entry.state === "created" || entry.state === "unknown"); },
    async entries() { return [...journalEntries.values()]; },
  };
  const bridge = new TrustedRuntimeJournalBridge(runtimeJournal, store);
  let leaseSeen: WorkerLeaseContract | undefined;
  const createRuntime = (journal: TrustedRuntimeJournalBridge) => ({
    async create(lease: WorkerLeaseContract) {
      leaseSeen = lease;
      const identity = { missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, controllerRunId: controllerRunIdFor(lease) };
      await journal.recordIntent({ identity, name: `orloom-fixture-${lease.leaseEpoch}`, imageRef, labelsDigest: hash("fixture-runtime-labels") });
      return {
        async checkout(repository: string, baseSha: string, signal?: AbortSignal) {
          assert.equal(repository, "owner/repo");
          assert.equal(baseSha, "a".repeat(40));
          checkoutReachedResolve();
          if (signal?.aborted) { abortedResolve(); throw new Error("held checkout aborted"); }
          await timeout(new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => { abortedResolve(); reject(new Error("held checkout aborted")); }, { once: true });
          }), "checkout cancellation signal was not observed");
        },
        async readFile() { throw new Error("unexpected tool read"); },
        async listFiles() { throw new Error("unexpected tool listing"); },
        async createFile() {}, async replaceText() { throw new Error("unexpected workspace edit"); },
        async runCheck() { throw new Error("unexpected check execution"); },
        async commitCandidate() { candidateCommits++; throw new Error("candidate commit forbidden"); },
        async close() { workspaceCloses++; },
      };
    },
  });
  let control!: HttpControlPlane;
  const controlFetch: typeof fetch = async (input, init) => {
    const response = await safeFetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/cancellation") && response.ok && (await response.clone().json() as { requested?: boolean }).requested === true) pollResolve();
    return response;
  };
  const slice = { id: "slice-one", objective: "bounded fixture", dependencies: [], owner: "builder", scopes: ["src/**"], checks, budgetCents: 100 };
  let governor!: MissionGovernor;
  let claims = 0;
  const serviceGovernor = new Proxy(new MissionGovernor(store, {
    maxLanes: 1, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicy: checks,
    trustedCheckPolicyDigest: policyDigest, executionConfigured: true,
  }), {
    get(target, property, receiver) {
      if (property === "claimApproved") return async (...args: Parameters<MissionGovernor["claimApproved"]>) => { claims++; return target.claimApproved(...args); };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MissionGovernor;
  governor = serviceGovernor;
  let servicePromise: Promise<{ value: unknown } | { error: unknown }> | undefined;
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
    control = new HttpControlPlane(baseUrl, "worker-bootstrap-fixture", controlFetch);
    const login = await safeFetch(`${baseUrl}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) });
    assert.equal(login.status, 204);
    ownerCookie = login.headers.get("set-cookie")?.split(";")[0] ?? undefined; assert(ownerCookie);
    const ownerFetch = (path: string, method = "GET", body?: unknown) => safeFetch(`${baseUrl}${path}`, {
      method, headers: { cookie: ownerCookie!, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const created = await ownerFetch("/api/missions", "POST", { repository: "owner/repo", baseSha: "a".repeat(40), objective: "prove owner HTTP cancellation", acceptance: ["worker observes cancellation"], budgetCents: 100 });
    assert.equal(created.status, 201);
    missionId = (await created.json() as { id: string }).id;
    assert.equal((await ownerFetch(`/api/missions/${missionId}/plan`, "POST", { slices: [slice] })).status, 201);
    assert.equal((await ownerFetch(`/api/missions/${missionId}/approve`, "POST", {})).status, 200);
    const planDigest = hash(canonicalJson([slice]));
    const task = { missionId, sliceId: slice.id, repository: "owner/repo", baseSha: "a".repeat(40), planDigest, trustedCheckPolicyDigest: policyDigest, maxBudgetCents: 100, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const executionLimits = { reservedBudgetCents: 100, maxProviderCalls: 1, maxInputTokens: 10_000, maxOutputTokens: 64, maxWallSeconds: 30, allowedProviders: ["deepseek"], allowedModels: [model] };
    const service = runApprovedWorkerService({ task, executionLimits, minimumSliceBudgetCents: 1, leaseSeconds: 300 }, {
      governor: serviceGovernor, store, trustedChecks: {} as TrustedCheckCoordinator,
      async reconcileInterrupted() {}, async reconcileRetained() {},
      executeLane: (lease, binding, signal, lifecycleGuard) => runApprovedWorkerLane(lease, {
        store, binding: { missionId: binding.missionId, slice, baseSha: binding.baseSha, planDigest: binding.planDigest, trustedCheckPolicyDigest: binding.trustedCheckPolicyDigest },
        control, provider, createRuntime, evidence,
        progress: { async append(_lease, event) { const digest = hash(JSON.stringify(event)); return { decision: "CONTINUE", reference: `sha256/${digest}:${digest}`, digest }; } },
        checks: { "check:unit": ["fixture"] }, options, trustedChecks: {} as TrustedCheckCoordinator, runtimeJournal: bridge,
        signal, ...(lifecycleGuard ? { lifecycleGuard } : {}),
      }),
    });
    servicePromise = service.then(value => ({ value }), error => ({ error }));
    await timeout(checkoutReached, "service did not reach held checkout");
    assert(leaseSeen, "the approved service claimed and dispatched one lease");
    const unauth = await safeFetch(`${baseUrl}/api/missions/${missionId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerRequestId: "http-cancel-test-1", reason: "fixture owner stop" }) });
    assert.equal(unauth.status, 401);
    const cancelled = await ownerFetch(`/api/missions/${missionId}/cancel`, "POST", { ownerRequestId: "http-cancel-test-1", reason: "fixture owner stop" });
    ownerCancellationCalls++;
    assert.equal(cancelled.status, 202);
    const workerState = await timeout(cancellationPollSeen, "worker lease cancellation poll did not observe durable intent");
    void workerState;
    await timeout(checkoutAborted, "owner HTTP cancellation did not abort held checkout");
    const state = await store.getMission(missionId);
    assert(state);
    assert.equal(state.mission.status, "cancelling");
    assert.equal(state.slices[0]?.status, "cancel_requested");
    assert.equal(state.slices[0]?.leaseExpiresAt !== null, true);
    assert.equal(state.mission.reservedCents, 100);
    const completion = await timeout(servicePromise, "approved worker service did not finish after cancellation");
    assert("error" in completion, "cancellation guard should stop post-execution lane effects without claiming settlement");
    assert(completion.error instanceof LifecycleStoppedError);
    assert.equal(claims, 1, "runApprovedWorkerService claimed exactly once");
    assert.equal(modelListFakeCalls, 1, "only the in-process fake model identity call ran");
    assert.equal(probeToolsCalls, 0);
    assert.equal(completionCalls, 0);
    assert.equal(candidateCommits, 0);
    assert.equal(integrations, 0);
    assert.equal(workspaceCloses, 1);
    assert.equal(ownerCancellationCalls, 1);
    assert.equal(remoteRequests.some(path => path.includes("provider") || path.includes("github") || path.includes("r2")), false);
    assert.equal(remoteRequests.every(path => path.startsWith("/") && path !== "/"), true);
    const finalState = await store.getMission(missionId);
    assert(finalState);
    assert.equal(finalState.mission.status, "cancelling");
    assert.equal(finalState.slices[0]?.status, "cancel_requested");
    assert.equal(finalState.slices[0]?.candidateSha, null);
    assert.equal(finalState.slices[0]?.leaseExpiresAt !== null, true);
    assert.equal(finalState.mission.reservedCents, 100);
  } finally {
    if (missionId && ownerCookie && baseUrl && !ownerCancellationCalls) {
      await safeFetch(`${baseUrl}/api/missions/${missionId}/cancel`, { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ ownerRequestId: "http-cancel-test-cleanup", reason: "fixture cleanup" }) }).catch(() => undefined);
    }
    if (servicePromise) await Promise.race([servicePromise, new Promise(resolve => setTimeout(resolve, 2_000))]);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
