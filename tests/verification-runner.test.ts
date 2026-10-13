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
import { classifyLauncherOutput } from "../packages/verification/src/runsc-launcher.js";

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
  assert.equal(policy.cwd, "/work/source");
  assert.throws(() => getCheckPolicy("bash -c arbitrary"), /finite policy/);
});

test("launcher process-result fixtures reject infrastructure ambiguity and accept only matching check markers", async () => {
  const marker = (exitCode: number, truncated = false) => `ORLOOM-RESULT:${Buffer.from(JSON.stringify({ exitCode, truncated, stdoutBytes: 2, stderrBytes: 0, stdout: Buffer.from("ok").toString("base64"), stderr: "" })).toString("base64")}\n`;
  const pass = classifyLauncherOutput(marker(0), { exitCode: 0 }, 64);
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.stdout.toString(), "ok");
  const fail = classifyLauncherOutput(marker(1), { exitCode: 1 }, 64);
  assert.equal(fail.exitCode, 1);

  for (const fixture of [
    { name: "pass marker then infra failure", stdout: marker(0), result: { exitCode: 70, stderr: "Docker transport failed" } },
    { name: "timeout after marker", stdout: marker(0), result: { exitCode: null, timedOut: true, killed: true } },
    { name: "signal after marker", stdout: marker(0), result: { exitCode: null, signal: "SIGTERM" } },
    { name: "missing marker", stdout: "", result: { exitCode: 0 } },
    { name: "duplicate marker", stdout: marker(0) + marker(0), result: { exitCode: 0 } },
    { name: "malformed marker", stdout: "ORLOOM-RESULT:not-base64-json\n", result: { exitCode: 0 } },
    { name: "marker/process disagreement", stdout: marker(0), result: { exitCode: 1 } },
    { name: "truncated process output", stdout: marker(0), result: { exitCode: 0, truncated: true } },
  ]) {
    const actual = classifyLauncherOutput(fixture.stdout, fixture.result, 64);
    assert.equal(actual.exitCode, null, fixture.name);
    assert.equal(actual.timedOut, true, fixture.name);
  }

  const policy = getCheckPolicy("node-validate-syntax");
  const checkScript = await import("node:fs/promises").then(({ readFile }) => readFile("infra/verifier-isolation/run-check.js", "utf8"));
  assert(checkScript.includes(`cwd: path.join(input, 'source')`));
  assert.equal(policy.cwd, path.posix.join("/work", "source"));
});

test("trusted staged archive layout matches launcher extraction, manifest reader, and policy cwd", async () => {
  const { readFile } = await import("node:fs/promises");
  const [launcher, checkScript] = await Promise.all([
    readFile("infra/verifier-isolation/launch-verifier.sh", "utf8"),
    readFile("infra/verifier-isolation/run-check.js", "utf8"),
  ]);
  assert.match(launcher, /tar -xf - -C \/work && cd \/work\/source/);
  assert.doesNotMatch(launcher, /tar -xf - -C \/work\/source/);
  assert(checkScript.includes("path.join(input, 'manifest.json')"));
  assert(checkScript.includes("path.join(input, 'source', item.path)"));
  assert(checkScript.includes("cwd: path.join(input, 'source')"));
  assert.equal(getCheckPolicy("node-validate-syntax").cwd, "/work/source");
});
