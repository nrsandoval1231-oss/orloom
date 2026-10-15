import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileRuntimeJournal,
  RUNTIME_RECONCILER_SOURCE,
  type RuntimeJournalEntry,
  type RuntimeIdentity,
  type RuntimeReconciliationObservation,
} from "../apps/worker/src/runtime-journal.js";

const imageRef = `sha256:${"a".repeat(64)}`;
const labelsDigest = "b".repeat(64);
const containerId = "c".repeat(64);

function identity(missionId = "mission/one"): RuntimeIdentity {
  return { missionId, sliceId: "slice-1", leaseEpoch: 3, controllerRunId: "run-1" };
}

function intent(runtimeIdentity = identity()) {
  return { identity: runtimeIdentity, name: "orloom-worker-3-abcd1234", imageRef, labelsDigest };
}

function observation(entry: RuntimeJournalEntry, outcome: "absent" | "unknown"): RuntimeReconciliationObservation {
  return {
    source: RUNTIME_RECONCILER_SOURCE,
    outcome,
    identity: entry.identity,
    name: entry.name,
    imageRef: entry.imageRef,
    labelsDigest: entry.labelsDigest,
    containerId: entry.containerId,
    observedAt: new Date(Date.now() + 1_000).toISOString(),
  };
}

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "orloom-journal-test-"));
  const root = path.join(parent, "journal");
  await mkdir(root, { mode: 0o700 });
  const journal = await FileRuntimeJournal.openPortableTestRoot(root);
  return { parent, root, journal };
}

test("portable journal opening quarantines a missing root instead of treating it as empty", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "orloom-journal-missing-"));
  try {
    await assert.rejects(FileRuntimeJournal.openPortableTestRoot(path.join(parent, "missing")), /quarantined/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal filenames cannot collide when identity fields contain filesystem punctuation", async () => {
  const f = await fixture();
  try {
    await f.journal.recordIntent(intent(identity("mission/one")));
    await f.journal.recordIntent(intent(identity("mission_one")));

    const rows = await f.journal.unresolved();
    assert.deepEqual(rows.map(row => row.identity.missionId).sort(), ["mission/one", "mission_one"]);
    assert.equal((await readdir(f.root)).filter(name => name.endsWith(".json")).length, 2);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("recordIntent never overwrites or reuses an identity, including an identical retained record", async () => {
  const f = await fixture();
  try {
    await f.journal.recordIntent(intent());
    await assert.rejects(f.journal.recordIntent({ ...intent(), imageRef: `sha256:${"d".repeat(64)}` }), /already exists/i);
    await assert.rejects(f.journal.recordIntent(intent()), /already exists/i);

    const [row] = await f.journal.unresolved();
    assert.equal(row?.imageRef, imageRef);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("created and unknown transitions preserve exact immutable runtime binding across restart", async () => {
  const f = await fixture();
  try {
    await f.journal.recordIntent(intent());
    await f.journal.recordCreated(identity(), containerId, labelsDigest);
    let [row] = await f.journal.unresolved();
    assert.equal(row?.state, "created");
    assert.equal(row?.containerId, containerId);

    await f.journal.recordUnknown(observation(row!, "unknown"));
    const reopened = await FileRuntimeJournal.openPortableTestRoot(f.root);
    [row] = await reopened.unresolved();
    assert.equal(row?.state, "unknown");
    assert.equal(row?.containerId, containerId);
    assert.equal(row?.reconciliation?.source, RUNTIME_RECONCILER_SOURCE);
    await assert.rejects(reopened.recordAbsent({ ...observation(row!, "absent"), containerId: "d".repeat(64) }), /does not match/i);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("absence requires trusted source evidence bound to every persisted runtime field", async () => {
  const f = await fixture();
  try {
    await f.journal.recordIntent(intent());
    await f.journal.recordCreated(identity(), containerId, labelsDigest);
    const [created] = await f.journal.unresolved();
    assert(created);

    await assert.rejects(f.journal.recordAbsent({ ...observation(created, "absent"), name: "orloom-worker-3-wrong000" }), /does not match/i);
    await assert.rejects(f.journal.recordAbsent({ ...observation(created, "absent"), containerId: "d".repeat(64) }), /does not match/i);
    assert.equal((await f.journal.unresolved())[0]?.state, "created");

    await f.journal.recordAbsent(observation(created, "absent"));
    assert.deepEqual(await f.journal.unresolved(), []);
    await assert.rejects(f.journal.recordIntent(intent()), /already exists/i, "retained absence must prevent identity reuse");
    assert.equal((await readdir(f.root)).filter(name => name.endsWith(".json")).length, 1);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("a stale reconciliation observation cannot resolve newer durable state", async () => {
  const f = await fixture();
  try {
    await f.journal.recordIntent(intent());
    const [entry] = await f.journal.unresolved();
    assert(entry);
    await assert.rejects(f.journal.recordAbsent({ ...observation(entry, "absent"), observedAt: "2020-01-01T00:00:00.000Z" }), /stale/i);
    assert.equal((await f.journal.unresolved())[0]?.state, "intent");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("malformed, unsupported, oversized, symlinked, and temporary evidence quarantines the root", async t => {
  const cases: Array<{ name: string; prepare(root: string): Promise<void> }> = [
    { name: "malformed", prepare: root => writeFile(path.join(root, `${"a".repeat(64)}.json`), "{") },
    { name: "unsupported file", prepare: root => writeFile(path.join(root, "operator-note.txt"), "unexpected") },
    { name: "oversized", prepare: root => writeFile(path.join(root, `${"a".repeat(64)}.json`), "x".repeat(70_000)) },
    { name: "interrupted temp", prepare: root => writeFile(path.join(root, ".runtime-journal.interrupted.tmp"), "evidence") },
  ];

  for (const row of cases) await t.test(row.name, async () => {
    const f = await fixture();
    try {
      await row.prepare(f.root);
      await assert.rejects(f.journal.unresolved(), /quarantined/i);
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });

  await t.test("symlinked record", async t => {
    const f = await fixture();
    try {
      const outside = path.join(f.parent, "outside.json");
      await writeFile(outside, "{}");
      try { await symlink(outside, path.join(f.root, `${"a".repeat(64)}.json`), "file"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows symlink privilege is unavailable"); return; }
        throw error;
      }
      await assert.rejects(f.journal.unresolved(), /quarantined/i);
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });
});

test("unsupported versions are rejected even when the row claims to be absent", async () => {
  const f = await fixture();
  try {
    await f.journal.recordIntent(intent());
    const [entry] = await f.journal.unresolved();
    assert(entry);
    await f.journal.recordAbsent(observation(entry, "absent"));
    const [file] = (await readdir(f.root)).filter(name => name.endsWith(".json"));
    assert(file);
    const raw = JSON.parse(await readFile(path.join(f.root, file), "utf8")) as Record<string, unknown>;
    raw.version = "orloom.runtime-journal.v1";
    await writeFile(path.join(f.root, file), JSON.stringify(raw));
    await assert.rejects(f.journal.unresolved(), /quarantined/i);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("an ambiguous filesystem failure retains the exclusive quarantine marker", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, `${"a".repeat(64)}.json`), "{");
    await assert.rejects(f.journal.unresolved(), /quarantined/i);
    assert((await readdir(f.root)).includes(".runtime-journal.lock"));
    await assert.rejects(f.journal.unresolved(), /exclusive journal lock/i);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("operational journal opening is Linux-only and cannot silently use portable validation", async t => {
  if (process.platform === "linux") { t.skip("Linux ownership and mode checks require the deployment-host acceptance lane"); return; }
  const f = await fixture();
  try {
    await assert.rejects(FileRuntimeJournal.openOperational(f.root), /Linux/i);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
