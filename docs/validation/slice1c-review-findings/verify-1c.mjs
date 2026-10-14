// Slice 1c verification. Read-only. Run with cwd = repo root.
// A) R5: do the committed artifact-sha256.txt files match the committed blobs?
// B) R3: is a valid created -> unknown -> absent history readable after writing?
// C) R4: does recordIntent enforce the record cap before writing?
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const run = (args, opts = {}) => execFileSync("git", args, { cwd: repo, maxBuffer: 1 << 28, ...opts });

console.log("=== A) committed artifact hash integrity ===");
for (const dir of ["docs/validation/slice0-baseline", "docs/validation/slice1a-runtime-intent", "docs/validation/slice1b-owner-cancellation", "docs/validation/slice1c-review-findings"]) {
  let list;
  try { list = run(["show", `HEAD:${dir}/artifact-sha256.txt`]).toString("utf8"); }
  catch { console.log(`${dir}: NO committed artifact-sha256.txt`); continue; }
  const entries = list.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  let ok = 0; const bad = [];
  for (const line of entries) {
    const [want, name] = line.split(/\s+/);
    let bytes;
    try { bytes = run(["show", `HEAD:${dir}/${name}`]); }
    catch { bad.push(`${name}: NOT COMMITTED`); continue; }
    const got = sha256(bytes);
    if (got === want) ok++; else bad.push(`${name}: listed=${want.slice(0, 12)} actual=${got.slice(0, 12)}`);
  }
  console.log(`${dir}: ${ok}/${entries.length} match${bad.length ? " | MISMATCH: " + bad.join("; ") : ""}`);
}

console.log("\n=== B/C) runtime journal behaviour at HEAD ===");
const mod = await import(pathToFileURL(path.join(repo, "dist/apps/worker/src/runtime-journal.js")).href);
const root = mkdtempSync(path.join(tmpdir(), "orloom-1c-"));
const identity = { missionId: "m", sliceId: "s", leaseEpoch: 1, controllerRunId: "r".repeat(8) };
const imageRef = `sha256:${"a".repeat(64)}`;
const name = "orloom-worker-1-abcdef01";
const labelsDigest = mod.ownershipLabelsDigest({ "com.orloom.worker-owned": "true" });
const journal = await mod.FileRuntimeJournal.openPortableTestRoot(root);
await journal.recordIntent({ identity, name, imageRef, labelsDigest });
await journal.recordCreated(identity, "b".repeat(64), labelsDigest);
const observation = (outcome, containerId, observedAt) => ({
  source: mod.RUNTIME_RECONCILER_SOURCE, outcome, identity, name, imageRef, labelsDigest, containerId, observedAt,
});
await journal.recordUnknown(observation("unknown", "b".repeat(64), new Date(Date.now() + 1000).toISOString()));
let writeError = null;
try { await journal.recordAbsent(observation("absent", "b".repeat(64), new Date(Date.now() + 2000).toISOString())); }
catch (error) { writeError = `${error.name}: ${error.message}`; }
console.log(`created -> unknown -> absent write: ${writeError ? "REJECTED: " + writeError : "accepted"}`);
let reopen = null;
try {
  const reopened = await mod.FileRuntimeJournal.openPortableTestRoot(root);
  const entries = await reopened.unresolved();
  reopen = `readable, ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, state=${entries[0]?.state}`;
} catch (error) { reopen = `QUARANTINED: ${error.name}: ${error.message}`; }
console.log(`reopen after that write: ${reopen}`);

console.log("\n=== record cap constants ===");
const source = readFileSync(path.join(repo, "apps/worker/src/runtime-journal.ts"), "utf8");
console.log(`maxJournalFiles declared: ${/maxJournalFiles\s*=\s*([\d_]+)/.exec(source)?.[1] ?? "unknown"}`);
console.log(`readAllLocked quarantine threshold present: ${/entries\.length > maxJournalFiles \+ 1/.test(source)}`);
console.log(`pre-write cap guard present in recordIntent: ${/rows\.size >= maxJournalFiles/.test(source)}`);
rmSync(root, { recursive: true, force: true });
