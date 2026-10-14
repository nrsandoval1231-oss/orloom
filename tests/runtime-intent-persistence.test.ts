import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { controllerRunIdFor, createContainerWithDurableIntent, ownershipLabels } from "../apps/worker/src/docker-runtime.js";
import { FileRuntimeJournal, ownershipLabelsDigest, type RuntimeIdentity } from "../apps/worker/src/runtime-journal.js";
import { workerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

const imageRef = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const otherContainerId = "c".repeat(64);
const name = "orloom-worker-3-0f1e2d3c";
const identity: RuntimeIdentity = { missionId: "mission-1", sliceId: "slice-2", leaseEpoch: 3, controllerRunId: "d".repeat(64) };

function lease(epoch = 3) {
  return workerLeaseContract({
    mission: { id: "mission-1", repository: "owner/repo", baseSha: "e".repeat(40), objective: "Ship the slice", acceptance: ["checks pass"] },
    slice: { id: "slice-2", objective: "Bounded work", dependencies: [], owner: "worker", scopes: ["src/**"], checks: ["node-validate-syntax"] },
    capacitySlot: 1,
    leaseEpoch: epoch,
    leaseToken: "lease-token",
    capabilityToken: "capability-token",
    leaseExpiresAt: "2026-10-14T00:00:00.000Z",
    trustedCheckPolicyDigest: "f".repeat(64),
    planDigest: "1".repeat(64),
    executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: ["deepseek-flash"] },
  });
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "orloom-runtime-intent-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("runtime intent is durable before the container is created", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    let observedBeforeCreation: Awaited<ReturnType<typeof journal.unresolved>> = [];
    await createContainerWithDurableIntent({
      journal, identity, name, imageRef, labels,
      create: async () => {
        const restarted = await FileRuntimeJournal.openPortableTestRoot(root);
        observedBeforeCreation = await restarted.unresolved();
        return { id: containerId };
      },
    });
    assert.equal(observedBeforeCreation.length, 1, "exactly one durable intent exists while creation is in flight");
    const entry = observedBeforeCreation[0]!;
    assert.equal(entry.state, "intent");
    assert.equal(entry.containerId, null, "no container identity may be claimed before creation returns");
    assert.equal(entry.name, name);
    assert.equal(entry.imageRef, imageRef);
    assert.deepEqual(entry.identity, identity);
  });
});

test("the retained container identity is bound to the durable intent after creation", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    const result = await createContainerWithDurableIntent({ journal, identity, name, imageRef, labels, create: async () => ({ id: containerId }) });
    assert.equal(result.id, containerId);
    const entries = await journal.unresolved();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.state, "created");
    assert.equal(entries[0]!.containerId, containerId);
    assert.equal(entries[0]!.labelsDigest, ownershipLabelsDigest(labels));
    assert.deepEqual(entries[0]!.history.map(row => row.state), ["intent", "created"]);
  });
});

test("a failed creation leaves the durable intent unresolved and records no container", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    await assert.rejects(
      createContainerWithDurableIntent({ journal, identity, name, imageRef, labels, create: async () => { throw new Error("docker create outcome is unknown"); } }),
      /docker create outcome is unknown/,
    );
    const entries = await journal.unresolved();
    assert.equal(entries.length, 1, "the durable intent is retained as evidence of a possible container");
    assert.equal(entries[0]!.state, "intent");
    assert.equal(entries[0]!.containerId, null);
  });
});

test("a restarted journal retains the exact container identity and refuses to recreate the identity", async () => {
  await withRoot(async root => {
    const first = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    await createContainerWithDurableIntent({ journal: first, identity, name, imageRef, labels, create: async () => ({ id: containerId }) });

    const restarted = await FileRuntimeJournal.openPortableTestRoot(root);
    const entries = await restarted.unresolved();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.state, "created");
    assert.equal(entries[0]!.containerId, containerId, "the retained container identity survives restart");

    await assert.rejects(
      createContainerWithDurableIntent({ journal: restarted, identity, name, imageRef, labels, create: async () => ({ id: otherContainerId }) }),
      /already exists/,
      "a restarted worker must not create a second container for the same controller identity",
    );
    assert.equal((await restarted.unresolved())[0]!.containerId, containerId);
  });
});

test("the durable intent binds the exact ownership labels used for creation", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    await createContainerWithDurableIntent({ journal, identity, name, imageRef, labels, create: async () => ({ id: containerId }) });
    assert.equal(labels["com.orloom.worker-owned"], "true");
    assert.equal(labels["com.orloom.lease-epoch"], "3");
    assert.equal(labels["com.orloom.instance"], name);
    assert.equal((await journal.unresolved())[0]!.labelsDigest, ownershipLabelsDigest(labels));
    await assert.rejects(
      journal.recordCreated(identity, otherContainerId, "9".repeat(64)),
      /does not match a durable intent/,
      "a container identity digest that does not match the durable intent is refused",
    );
  });
});

test("the controller run identity derives from controller-issued lease facts and follows the epoch", () => {
  const granted = lease(3), nextEpoch = lease(4);
  assert.equal(controllerRunIdFor(granted), controllerRunIdFor(lease(3)), "the same lease facts derive the same identity");
  assert.notEqual(controllerRunIdFor(granted), controllerRunIdFor(nextEpoch), "a new lease epoch derives a new run identity");
  assert.match(controllerRunIdFor(granted), /^[a-f0-9]{64}$/);
});

test("the durable ownership-labels digest is byte-ordered and independent of insertion order", () => {
  const labels = ownershipLabels(name, 3);
  const expected = createHash("sha256").update(JSON.stringify(Object.entries(labels).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))).digest("hex");
  assert.equal(ownershipLabelsDigest(labels), expected, "the digest must not depend on host locale collation");
  const reordered = Object.fromEntries(Object.entries(labels).reverse());
  assert.equal(ownershipLabelsDigest(reordered), ownershipLabelsDigest(labels), "insertion order must not change the durable digest");
  assert.notEqual(ownershipLabelsDigest(labels), ownershipLabelsDigest({ ...labels, "com.orloom.instance": `${name}-other` }), "a different exact label set must change the digest");
});
