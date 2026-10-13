import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { DurableArtifactStore } from "../packages/verification/src/artifact-store.js";
import { extractCandidateBundle } from "../packages/verification/src/repository.js";
import { getCheckPolicy } from "../packages/verification/src/policy.js";

const exec = promisify(execFile);
async function git(dir: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", dir, "-c", "user.name=Verifier Fixture", "-c", "user.email=fixture@example.invalid", ...args], { windowsHide: true });
}

test("durable artifacts are content-addressed and reject tampering and symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orl-artifact-"));
  try {
    const store = new DurableArtifactStore(path.join(root, "evidence"));
    const receipt = await store.put(Buffer.from("proof"));
    assert.equal((await store.verify(receipt)).toString(), "proof");
    await assert.rejects(store.read(`sha256/${"0".repeat(64)}` as `sha256/${string}`));
    await writeFile(path.join(root, "outside"), "tampered");
    await rm(path.join(root, "evidence", receipt.sha256));
    await writeFile(path.join(root, "evidence", receipt.sha256), "tampered");
    await assert.rejects(store.read(receipt.key), /hash mismatch/);
    if (process.platform !== "win32") {
      await rm(path.join(root, "evidence", receipt.sha256));
      await symlink(path.join(root, "outside"), path.join(root, "evidence", receipt.sha256));
      await assert.rejects(store.read(receipt.key));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extractor only accepts reachable commit regular files and rejects symlink entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orl-git-")), work = path.join(root, "work"), bare = path.join(root, "objects.git");
  try {
    await mkdir(work); await git(root, "init", "--bare", bare); await git(work, "init", "-b", "main");
    await writeFile(path.join(work, "scripts-placeholder"), "safe"); await git(work, "add", "."); await git(work, "commit", "-m", "safe");
    await git(work, "remote", "add", "trusted", bare); await git(work, "push", "trusted", "HEAD:refs/heads/main");
    const { stdout } = await exec("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
    const config = { objectStore: bare, approvedRef: "refs/heads/main" };
    const bundle = await extractCandidateBundle(config, stdout.trim(), stdout.trim());
    assert.equal(bundle.files.get("scripts-placeholder")?.toString(), "safe");
    const { stdout: linkBlob } = await exec("git", ["-C", work, "hash-object", "-w", "scripts-placeholder"], { encoding: "utf8", windowsHide: true });
    await git(work, "update-index", "--add", "--cacheinfo", "120000", linkBlob.trim(), "link"); await git(work, "commit", "-m", "symlink"); await git(work, "push", "trusted", "HEAD:refs/heads/main");
    const { stdout: bad } = await exec("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
    await assert.rejects(extractCandidateBundle(config, bad.trim(), stdout.trim()), /descendant/);
    await assert.rejects(extractCandidateBundle(config, stdout.trim(), bad.trim()), /symlink|unsupported/);
    await assert.rejects(extractCandidateBundle({ ...config, approvedRef: "refs/heads/../../main" }, stdout.trim(), bad.trim()));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("check policy is finite and worker text cannot select commands", () => {
  const policy = getCheckPolicy("node-validate-syntax");
  assert.deepEqual(policy.argv, ["/usr/local/bin/node", "--check", "scripts/validate.mjs"]);
  assert.throws(() => getCheckPolicy("bash -c arbitrary"), /finite policy/);
});
