import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerWorkerRuntime } from "../apps/worker/src/docker-runtime.js";
import { runWorkerPollPool } from "../apps/worker/src/poll-pool.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

function lease(id: string): WorkerLeaseContract {
  const digest = "b".repeat(64);
  return {
    protocol: "orloom.worker-lease.v1",
    mission: { id: `mission-${id}`, repository: "owner/repo", baseSha: "a".repeat(40), objective: "test", acceptance: ["test"] },
    slice: { id: `slice-${id}`, objective: "test", dependencies: [], owner: "builder", scopes: ["src/**"], checks: ["check:unit"] },
    capacitySlot: id === "one" ? 1 : 2,
    leaseEpoch: id === "one" ? 1 : 2,
    leaseToken: `lease-${id}`,
    capabilityToken: `capability-${id}`,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    trustedCheckPolicyDigest: digest,
    planDigest: digest,
    executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 2, maxInputTokens: 1000, maxOutputTokens: 1000, maxWallSeconds: 30, allowedProviders: ["deepseek"], allowedModels: ["deepseek-chat"] }
  };
}

test("two configured poll slots execute distinct leases concurrently and drain on shutdown", async () => {
  const leases = [lease("one"), lease("two")];
  let cursor = 0;
  const shutdown = new AbortController();
  const starts = new Set<string>();
  const finishes: Array<() => void> = [];
  let signalStarted!: () => void;
  const bothStarted = new Promise<void>(resolve => { signalStarted = resolve; });
  const pool = runWorkerPollPool({
    concurrency: 2,
    pollIntervalMs: 10,
    signal: shutdown.signal,
    async claim() { return leases[cursor++] ?? null; },
    async execute(value) {
      starts.add(value.mission.id);
      if (starts.size === 2) signalStarted();
      await new Promise<void>(resolve => finishes.push(resolve));
    }
  });
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([bothStarted, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("poll slots did not overlap")), 5_000); })]).finally(() => clearTimeout(timeout));
  assert.deepEqual([...starts].sort(), ["mission-one", "mission-two"]);
  shutdown.abort();
  for (const finish of finishes) finish();
  await pool;
  assert.equal(cursor, 2, "no additional lease is claimed while both slots are occupied");
});

test("each lease receives a distinct isolated workspace instance", async () => {
  const runtime = new DockerWorkerRuntime({ imageRef: `sha256:${"d".repeat(64)}`, installationId: 1, checkoutTokens: { async createCheckoutToken() { return "not-used"; } }, checks: {} });
  const first = await runtime.create(lease("one"));
  const second = await runtime.create(lease("two"));
  assert.notStrictEqual(first, second);
  await Promise.all([first.close(), second.close()]);
});
