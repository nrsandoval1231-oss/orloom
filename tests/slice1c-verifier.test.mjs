import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeCommit, verifyArtifactManifest, verifyManifests } from "../docs/validation/slice1c-review-findings/verify-1c.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orloom-verify-test-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Verifier Test");
  git("config", "user.email", "verifier@example.invalid");
  git("config", "core.autocrlf", "false");
  return { root, repo, git };
}

function commit(git) {
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  return git("rev-parse", "HEAD");
}

test("the requested commit is materialized independently of dirty worktree files", () => {
  const f = fixture();
  let materialized;
  try {
    writeFileSync(path.join(f.repo, "source.txt"), "committed bytes\n");
    const selected = commit(f.git);
    writeFileSync(path.join(f.repo, "source.txt"), "dirty worktree bytes\n");
    materialized = materializeCommit(f.repo, selected, f.root);
    assert.equal(f.git("rev-parse", "HEAD"), selected);
    assert.equal(readFileSync(path.join(materialized.checkout, "source.txt"), "utf8").replace(/\r\n/g, "\n"), "committed bytes\n");
  } finally {
    if (materialized) rmSync(materialized.root, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("committed artifact manifests require valid, present, matching blobs", () => {
  const f = fixture();
  try {
    const bytes = "retained evidence\n";
    const goodHash = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(path.join(f.repo, "evidence"));
    writeFileSync(path.join(f.repo, "evidence", "artifact.txt"), bytes);
    writeFileSync(path.join(f.repo, "evidence", "hashes.txt"), `${goodHash}  artifact.txt\n`);
    const good = commit(f.git);
    assert.equal(verifyArtifactManifest(f.repo, good, "evidence/hashes.txt").length, 1);
    assert.throws(() => verifyManifests(f.repo, good, []), /at least one artifact manifest/);
    assert.throws(() => verifyArtifactManifest(f.repo, good, "evidence/missing.txt"), /missing committed blob/);

    writeFileSync(path.join(f.repo, "evidence", "hashes.txt"), `${"0".repeat(64)}  artifact.txt\n`);
    const mismatch = commit(f.git);
    assert.throws(() => verifyArtifactManifest(f.repo, mismatch, "evidence/hashes.txt"), /hash mismatch/);

    writeFileSync(path.join(f.repo, "evidence", "hashes.txt"), "not a hash entry\n");
    const malformed = commit(f.git);
    assert.throws(() => verifyArtifactManifest(f.repo, malformed, "evidence/hashes.txt"), /malformed hash entry/);

    writeFileSync(path.join(f.repo, "evidence", "hashes.txt"), `${goodHash}  absent.txt\n`);
    const missingBlob = commit(f.git);
    assert.throws(() => verifyArtifactManifest(f.repo, missingBlob, "evidence/hashes.txt"), /missing committed blob/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
