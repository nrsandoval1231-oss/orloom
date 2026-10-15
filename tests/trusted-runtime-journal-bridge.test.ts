import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";
import type { RuntimeIdentity, RuntimeJournal, RuntimeJournalEntry } from "../apps/worker/src/runtime-journal.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("trusted journal bridge replays exact container binding after a transient SQL bind failure", async () => {
  const store = new MemoryMissionStore();
  const policyDigest = hash(JSON.stringify(["check"]));
  await store.configureCapacity(1, hash("capacity"), new Date(Date.now() + 60_000).toISOString());
  const mission = await store.submit({ repository: "owner/repo", baseSha: "a".repeat(40), objective: "fixture", acceptance: ["fixture"], budgetCents: 10 });
  const slice = { id: "slice", objective: "fixture", dependencies: [], owner: "owner", scopes: ["src"], checks: ["check"], budgetCents: 10 };
  await store.recommendPlan(mission.id, [slice], "owner"); await store.approvePlan(mission.id);
  const lease = await store.claim(60, policyDigest, ["check"]); assert(lease);
  const identity: RuntimeIdentity = { missionId: mission.id, sliceId: slice.id, leaseEpoch: lease.epoch, controllerRunId: hash("run") };
  const binding = { name: "orloom-worker-1-abcd1234", imageRef: `sha256:${"d".repeat(64)}`, labelsDigest: hash("labels") };
  let entry: RuntimeJournalEntry | undefined;
  const at = new Date().toISOString();
  const journal: RuntimeJournal = {
    recordIntent: async input => { entry = { ...input, version: "orloom.runtime-journal.v2", containerId: null, state: "intent", updatedAt: at, reconciliation: null, history: [{ state: "intent", at }] }; },
    recordCreated: async (_identity, containerId) => {
      assert(entry);
      entry = { ...entry, containerId, state: "created", updatedAt: new Date().toISOString(), history: [...entry.history, { state: "created", at: new Date().toISOString(), containerId }] };
    },
    recordUnknown: async () => {}, recordAbsent: async () => {}, unresolved: async () => entry && entry.state !== "absent" ? [entry] : [],
    entries: async () => entry ? [entry] : [],
  };
  const bridge = new TrustedRuntimeJournalBridge(journal, store);
  await bridge.recordIntent({ identity, ...binding });
  const originalBind = store.bindCancellationRuntimeContainer!.bind(store);
  let failOnce = true;
  store.bindCancellationRuntimeContainer = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error("transient database write failure"); }
    return originalBind(...args);
  };
  await assert.rejects(bridge.recordCreated(identity, "e".repeat(64), binding.labelsDigest), /transient/);
  assert.equal(entry?.state, "created", "the journal retains the exact container ID despite the database failure");
  await bridge.reconcileRetained(identity.controllerRunId);
  await store.bindCancellationRuntimeContainer(identity, "e".repeat(64));
});
