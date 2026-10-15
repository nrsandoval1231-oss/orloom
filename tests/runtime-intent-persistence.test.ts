import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { controllerRunIdFor, createContainerWithDurableIntent, ownershipLabels } from "../apps/worker/src/docker-runtime.js";
import { FileRuntimeJournal, ownershipLabelsDigest, type RuntimeIdentity, type RuntimeJournal } from "../apps/worker/src/runtime-journal.js";
import { workerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

const imageRef = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const otherContainerId = "c".repeat(64);
const name = "orloom-worker-3-0f1e2d3c";
const identity: RuntimeIdentity = { missionId: "mission-1", sliceId: "slice-2", leaseEpoch: 3, controllerRunId: "d".repeat(64) };

function lease(epoch = 3, leaseExpiresAt = "2026-10-14T00:00:00.000Z") {
  return workerLeaseContract({
    mission: { id: "mission-1", repository: "owner/repo", baseSha: "e".repeat(40), objective: "Ship the slice", acceptance: ["checks pass"] },
    slice: { id: "slice-2", objective: "Bounded work", dependencies: [], owner: "worker", scopes: ["src/**"], checks: ["node-validate-syntax"] },
    capacitySlot: 1,
    leaseEpoch: epoch,
    leaseToken: "lease-token",
    capabilityToken: "capability-token",
    leaseExpiresAt,
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

test("a failed recordCreated after a successful create retains the unresolved intent and claims no ID", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    let createdId: string | null = null;
    const failing: RuntimeJournal = {
      recordIntent: input => journal.recordIntent(input),
      recordCreated: async () => { throw new Error("durable create binding is unavailable"); },
      recordUnknown: observation => journal.recordUnknown(observation),
      recordAbsent: observation => journal.recordAbsent(observation),
      unresolved: () => journal.unresolved(),
    };
    await assert.rejects(
      createContainerWithDurableIntent({ journal: failing, identity, name, imageRef, labels, create: async () => { createdId = containerId; return { id: containerId }; } }),
      /durable create binding is unavailable/,
    );
    assert.equal(createdId, containerId, "the container really was created before the binding failed");
    const entries = await journal.unresolved();
    assert.equal(entries.length, 1, "the durable intent survives so the container remains reconcilable");
    assert.equal(entries[0]!.state, "intent", "a container must never be claimed without a durable binding");
    assert.equal(entries[0]!.containerId, null);
  });
});

test("distinct controller identities retain independent durable intents", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const second: RuntimeIdentity = { ...identity, sliceId: "slice-3" };
    const first = ownershipLabels(name, identity.leaseEpoch);
    const secondLabels = ownershipLabels("orloom-worker-3-99887766", identity.leaseEpoch);
    await createContainerWithDurableIntent({ journal, identity, name, imageRef, labels: first, create: async () => ({ id: containerId }) });
    await createContainerWithDurableIntent({ journal, identity: second, name: "orloom-worker-3-99887766", imageRef, labels: secondLabels, create: async () => ({ id: otherContainerId }) });
    const entries = await journal.unresolved();
    assert.equal(entries.length, 2, "one controller identity cannot overwrite another");
    const bySlice = new Map(entries.map(entry => [entry.identity.sliceId, entry]));
    assert.equal(bySlice.get("slice-2")!.containerId, containerId);
    assert.equal(bySlice.get("slice-3")!.containerId, otherContainerId);
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
  const digestOf = (entries: Array<[string, string]>) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const byteSorted = Object.entries(labels).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.equal(ownershipLabelsDigest(labels), digestOf(byteSorted), "the digest must use byte order");
  const reordered = Object.fromEntries(Object.entries(labels).reverse());
  assert.equal(ownershipLabelsDigest(reordered), ownershipLabelsDigest(labels), "insertion order must not change the durable digest");
  assert.notEqual(ownershipLabelsDigest(labels), ownershipLabelsDigest({ ...labels, "com.orloom.instance": `${name}-other` }), "a different exact label set must change the digest");
});

test("the persisted digest uses byte order, not host collation, where the two disagree", () => {
  // For the closed ownership-label set, collation and byte order happen to agree,
  // so that set cannot detect a collation-dependent implementation. This one can:
  // byte order puts "B" before "a"; en-US collation puts "a" before "B".
  const labels = { "a": "1", "B": "2" };
  const digestOf = (entries: Array<[string, string]>) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const byteSorted = Object.entries(labels).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const collated = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  assert.notDeepEqual(byteSorted, collated, "this label set must actually distinguish the two orderings");
  assert.equal(ownershipLabelsDigest(labels), digestOf(byteSorted));
  assert.notEqual(ownershipLabelsDigest(labels), digestOf(collated), "the replaced localeCompare implementation would produce a different durable digest");
});

test("the live container is placed under the caller's control before the durable binding is attempted", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    const labels = ownershipLabels(name, identity.leaseEpoch);
    const order: string[] = [];
    const failing: RuntimeJournal = {
      recordIntent: input => journal.recordIntent(input),
      recordCreated: async () => { order.push("recordCreated"); throw new Error("durable create binding is unavailable"); },
      recordUnknown: observation => journal.recordUnknown(observation),
      recordAbsent: observation => journal.recordAbsent(observation),
      unresolved: () => journal.unresolved(),
    };
    await assert.rejects(
      createContainerWithDurableIntent({
        journal: failing, identity, name, imageRef, labels,
        create: async () => { order.push("create"); return { id: containerId }; },
        retain: created => { order.push(`retain:${created.id}`); },
      }),
      /durable create binding is unavailable/,
    );
    assert.deepEqual(order, ["create", `retain:${containerId}`, "recordCreated"],
      "a failed binding must not orphan the container: the caller regains control first");
  });
});

test("a renewed lease expiry does not change the controller run identity", () => {
  assert.equal(controllerRunIdFor(lease(3, "2026-10-14T01:00:00.000Z")), controllerRunIdFor(lease(3)),
    "heartbeat renewal must not re-identify a live lease, which would admit a second container at the same epoch");
  assert.notEqual(controllerRunIdFor(lease(4)), controllerRunIdFor(lease(3)));
});
