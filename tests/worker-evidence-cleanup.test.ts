import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";
import { executeLease, type WorkerOptions } from "../packages/agents/src/worker.js";

const model = "deepseek-chat";
const trustedChecks = ["check:unit"];
const trustedCheckPolicyDigest = createHash("sha256").update(JSON.stringify(trustedChecks)).digest("hex");
const sandboxImageRef = `sha256:${"d".repeat(64)}`;
const options: WorkerOptions = {
  allowedModels: [model], allowedProviders: ["deepseek"], trustedChecks, trustedCheckPolicyDigest,
  trustedCheckCommands: { "check:unit": { executable: "node", args: ["test"], timeoutSeconds: 10 } },
  sandboxImageRef, maxToolCalls: 8,
  pricing: { model, version: "fixture-v1", source: "test", capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), inputCentsPerMillion: 100, outputCentsPerMillion: 100, reasoningCentsPerMillion: 100, safetyMultiplier: 1.25 }
};
const lease: WorkerLeaseContract = {
  protocol: "orloom.worker-lease.v1",
  mission: { id: "mission-cleanup", repository: "owner/repo", baseSha: "a".repeat(40), objective: "bounded test", acceptance: ["cleanup"] },
  slice: { id: "slice-cleanup", objective: "initial evidence cleanup", dependencies: [], owner: "builder", scopes: ["src/**"], checks: trustedChecks },
  capacitySlot: 1, leaseEpoch: 1, leaseToken: "fixture-lease", capabilityToken: "fixture-capability",
  leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), trustedCheckPolicyDigest, planDigest: "b".repeat(64),
  executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens: 10_000, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: [model] }
};

for (const failure of ["pricing-put", "pricing-get", "sandbox-put", "sandbox-get"] as const) {
  test(`${failure} failure cleans deadline/listener and reports one early BLOCKED result`, async () => {
    const initialFailure = {
      "pricing-put": { put: 1, get: 0 }, "pricing-get": { put: 1, get: 1 },
      "sandbox-put": { put: 2, get: 1 }, "sandbox-get": { put: 2, get: 2 }
    }[failure];
    let puts = 0, gets = 0, runtimeCreates = 0, probes = 0, completions = 0;
    const results: unknown[] = [];
    const signal = new AbortController().signal;
    let added = 0, removed = 0;
    const nativeAdd = signal.addEventListener.bind(signal);
    const nativeRemove = signal.removeEventListener.bind(signal);
    Object.defineProperty(signal, "addEventListener", { value: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => { if (type === "abort") added++; return nativeAdd(type, listener, options); } });
    Object.defineProperty(signal, "removeEventListener", { value: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => { if (type === "abort") removed++; return nativeRemove(type, listener, options); } });

    const blobs = new Map<string, Uint8Array>();
    const evidence = {
      async put(bytes: Uint8Array) {
        puts++;
        if (failure.endsWith("put") && puts === initialFailure.put) throw new Error(`${failure} fixture rejection`);
        const hash = createHash("sha256").update(bytes).digest("hex");
        blobs.set(`sha256/${hash}`, new Uint8Array(bytes));
        return { key: `sha256/${hash}`, sha256: hash };
      },
      async get(_key: string) {
        gets++;
        if (failure.endsWith("get") && gets === initialFailure.get) throw new Error(`${failure} fixture rejection`);
        return blobs.get(_key)!;
      }
    };
    const timers: unknown[] = [], cleared: unknown[] = [];
    const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const handle = nativeSetTimeout(handler, timeout, ...args);
      if (typeof timeout === "number" && timeout >= 59_000 && timeout <= 60_000) timers.push(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => { if (handle && timers.includes(handle)) cleared.push(handle); return nativeClearTimeout(handle); }) as typeof clearTimeout;
    try {
      await executeLease(lease, {
        control: { async claim() { return null; }, async heartbeat() { throw new Error("heartbeat must not start"); }, async result(_lease, result) { results.push(result); } },
        provider: { async listModels() { return [model]; }, async probeTools() { probes++; throw new Error("probe must not run"); }, async complete() { completions++; throw new Error("completion must not run"); } },
        runtime: { async create() { runtimeCreates++; throw new Error("runtime must not start"); } }, evidence,
        progress: { async append() { throw new Error("progress must not run"); } }, checks: { "check:unit": ["unit"] }, options, signal
      });
    } finally {
      globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout;
    }
    assert.equal(puts, initialFailure.put, "the failed initial evidence PUT is never retried");
    assert.equal(gets, initialFailure.get, "the failed initial evidence GET is never retried");
    assert.equal(runtimeCreates, 0); assert.equal(probes, 0); assert.equal(completions, 0);
    assert.deepEqual(results, [{ outcome: "BLOCKED", reasonCode: "other", evidenceRefs: [] }]);
    assert.equal(added, 1); assert.equal(removed, 1, "parent abort listener is removed on every initial evidence failure");
    assert.equal(timers.length, 1); assert.deepEqual(cleared, timers, "deadline timer is cleared on every initial evidence failure");
  });
}
