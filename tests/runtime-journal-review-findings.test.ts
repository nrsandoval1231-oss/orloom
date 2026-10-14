import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileRuntimeJournal, ownershipLabelsDigest, RUNTIME_RECONCILER_SOURCE, RuntimeJournalQuarantinedError, type RuntimeIdentity } from "../apps/worker/src/runtime-journal.js";

// Regressions for the independent review of PR #22. Both defects below were
// reproduced before the fix: the first quarantined the whole journal, the second
// bricked it at exactly the advertised record capacity.

const imageRef = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const name = "orloom-worker-1-0f1e2d3c";
const labelsDigest = ownershipLabelsDigest({ "com.orloom.worker-owned": "true", "com.orloom.lease-epoch": "1", "com.orloom.instance": name });
const identity: RuntimeIdentity = { missionId: "mission-1", sliceId: "slice-1", leaseEpoch: 1, controllerRunId: "c".repeat(8) };

const recordFileName = (value: RuntimeIdentity) => `${createHash("sha256").update(JSON.stringify([value.missionId, value.sliceId, value.leaseEpoch, value.controllerRunId])).digest("hex")}.json`;
const observation = (outcome: "unknown" | "absent", offsetMs: number) => ({
  source: RUNTIME_RECONCILER_SOURCE, outcome, identity, name, imageRef, labelsDigest, containerId,
  observedAt: new Date(Date.now() + offsetMs).toISOString(),
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "orloom-journal-review-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("a created -> unknown -> absent history is durable and readable after reopen", async () => {
  await withRoot(async root => {
    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    await journal.recordIntent({ identity, name, imageRef, labelsDigest });
    await journal.recordCreated(identity, containerId, labelsDigest);
    await journal.recordUnknown(observation("unknown", 1_000));
    await journal.recordAbsent(observation("absent", 2_000));

    // Before the fix this reopened as a QUARANTINED root: the write succeeded but
    // parseEntry rejected the four-item history, bricking every later access.
    const reopened = await FileRuntimeJournal.openPortableTestRoot(root);
    assert.equal((await reopened.unresolved()).length, 0, "a proven-absent runtime is settled and is not unresolved");

    const raw = JSON.parse(await readFile(path.join(root, recordFileName(identity)), "utf8")) as { state: string; history: Array<{ state: string }> };
    assert.equal(raw.state, "absent");
    assert.deepEqual(raw.history.map(row => row.state), ["intent", "created", "unknown", "absent"], "the full four-state history is retained, not collapsed");

    // The root is healthy rather than merely readable: identity reuse is still refused.
    await assert.rejects(reopened.recordIntent({ identity, name, imageRef, labelsDigest }), /already exists/);

    // `absent` is terminal: no further transition may be recorded, and each
    // refusal must leave the root readable rather than quarantined.
    await assert.rejects(reopened.recordCreated(identity, containerId, labelsDigest), /does not match a durable intent/);
    await assert.rejects(reopened.recordUnknown(observation("unknown", 3_000)), /transition is illegal/);
    await assert.rejects(reopened.recordAbsent(observation("absent", 3_000)), /transition is illegal/);
    const stillReadable = await FileRuntimeJournal.openPortableTestRoot(root);
    assert.equal((await stillReadable.unresolved()).length, 0, "refused post-absent transitions leave the root readable");
  });
});

test("an illegal four-item history is still quarantined", async () => {
  await withRoot(async root => {
    const at = new Date().toISOString();
    const file = recordFileName(identity);
    // Every transition here is individually well formed and bound to the same
    // static identity, but `intent>created>unknown>created` is not a legal
    // history. The widened cap must accept only the one new legal sequence.
    const illegal = {
      version: "orloom.runtime-journal.v2", identity, name, imageRef, labelsDigest,
      containerId, state: "created", updatedAt: at, reconciliation: null,
      history: [
        { state: "intent", at },
        { state: "created", at, containerId },
        { state: "unknown", at, observation: observation("unknown", 1_000) },
        { state: "created", at, containerId },
      ],
    };
    await writeFile(path.join(root, file), `${JSON.stringify(illegal)}\n`, "utf8");
    await assert.rejects(
      FileRuntimeJournal.openPortableTestRoot(root),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeJournalQuarantinedError, "an illegal sequence must quarantine the root");
        assert.match((error as Error).message, /transition is illegal/, "the quarantine reason must be the illegal sequence, not an unrelated defect");
        return true;
      },
    );
  });
});

test("unreachable histories are quarantined with the sequence reason", async () => {
  const at = new Date(0).toISOString();
  const transition = (state: string) =>
    state === "intent" ? { state, at }
      : state === "created" ? { state, at, containerId }
        : { state, at, observation: observation(state as "unknown" | "absent", 1_000) };
  const unreachable = [
    ["intent", "created", "unknown", "created"],
    ["intent", "unknown", "created"],
    ["intent", "created", "created"],
    ["intent", "unknown", "unknown"],
    ["intent", "created", "absent", "unknown"],
  ];
  for (const sequence of unreachable) {
    await withRoot(async root => {
      const history = sequence.map(transition);
      const last = history.at(-1) as { state: string; observation?: unknown };
      const crafted = {
        version: "orloom.runtime-journal.v2", identity, name, imageRef, labelsDigest,
        containerId: sequence.includes("created") ? containerId : null,
        state: last.state,
        updatedAt: at,
        reconciliation: last.state === "unknown" || last.state === "absent" ? last.observation : null,
        history,
      };
      await writeFile(path.join(root, recordFileName(identity)), `${JSON.stringify(crafted)}\n`, "utf8");
      await assert.rejects(
        FileRuntimeJournal.openPortableTestRoot(root),
        (error: unknown) => {
          assert.ok(error instanceof RuntimeJournalQuarantinedError, `${sequence.join(">")} must be quarantined`);
          assert.match((error as Error).message, /record (transition is illegal|fields are invalid|transition history is inconsistent)/, `${sequence.join(">")} must not be accepted`);
          return true;
        },
      );
    });
  }
});

test("the journal accepts its last free record, refuses the next, and stays readable throughout", async () => {
  // Deliberately exercises the REAL 10,000-record boundary (~10 s on this host),
  // on both sides: a guard that fired one record early would still pass a
  // refusal-only test.
  await withRoot(async root => {
    const cap = 10_000;
    const at = new Date().toISOString();
    const free = cap - 1;
    const record = (index: number) => {
      const value: RuntimeIdentity = { missionId: `m${index}`, sliceId: `s${index}`, leaseEpoch: 1, controllerRunId: `r${index}` };
      return {
        file: recordFileName(value),
        bytes: `${JSON.stringify({
          version: "orloom.runtime-journal.v2", identity: value,
          name: `orloom-worker-1-${String(index).padStart(8, "0")}`,
          imageRef, labelsDigest, containerId: null, state: "intent", updatedAt: at,
          reconciliation: null, history: [{ state: "intent", at }],
        })}\n`,
      };
    };
    for (let start = 0; start < free; start += 200) {
      const batch = [];
      for (let index = start; index < Math.min(start + 200, free); index++) {
        const row = record(index);
        batch.push(writeFile(path.join(root, row.file), row.bytes, "utf8"));
      }
      await Promise.all(batch);
    }

    const journal = await FileRuntimeJournal.openPortableTestRoot(root);
    assert.equal((await journal.unresolved()).length, free, "one record below the cap is still readable");

    // The last free slot must be accepted: an over-strict guard fails here.
    await journal.recordIntent({ identity, name, imageRef, labelsDigest });
    const atCapacity = await FileRuntimeJournal.openPortableTestRoot(root);
    assert.equal((await atCapacity.unresolved()).length, cap, "the final free record is accepted and readable");

    // Before the fix this write was ACCEPTED, pushing the root past the read
    // threshold so every subsequent access quarantined the whole journal.
    const overflow: RuntimeIdentity = { missionId: "overflow", sliceId: "overflow", leaseEpoch: 1, controllerRunId: "overflow" };
    await assert.rejects(
      atCapacity.recordIntent({ identity: overflow, name: "orloom-worker-1-99999999", imageRef, labelsDigest }),
      /record capacity is reached/,
      "a new intent must be refused rather than bricking the journal",
    );

    const reopened = await FileRuntimeJournal.openPortableTestRoot(root);
    assert.equal((await reopened.unresolved()).length, cap, "the journal survives the refused write");
  });
});
