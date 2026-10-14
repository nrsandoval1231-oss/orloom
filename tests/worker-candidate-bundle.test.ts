import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => out.push(value));
    child.stderr.on("data", (value: Buffer) => err.push(value));
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(out).toString("utf8").trim()) : reject(new Error(Buffer.concat(err).toString("utf8").slice(0, 1_000))));
  });
}

test("candidate bundle verifies against immutable base and advertises exact commit SHA", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orloom-candidate-bundle-"));
  const repo = path.join(root, "repo"), receiver = path.join(root, "receiver.git"), bundle = path.join(root, "candidate.bundle");
  await mkdir(repo);
  try {
    await git(["init", "--quiet"], repo);
    await git(["config", "user.name", "Orloom Test"], repo);
    await git(["config", "user.email", "worker@orloom.invalid"], repo);
    await writeFile(path.join(repo, "source.txt"), "base\n");
    await git(["add", "--", ":(literal)source.txt"], repo);
    await git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"], repo);
    const baseSha = await git(["rev-parse", "HEAD"], repo);
    await writeFile(path.join(repo, "source.txt"), "candidate\n");
    await git(["add", "--", ":(literal)source.txt"], repo);
    await git(["commit", "--quiet", "--no-gpg-sign", "-m", "candidate"], repo);
    const candidateSha = await git(["rev-parse", "HEAD"], repo);
    await git(["update-ref", "refs/heads/orloom-candidate", candidateSha], repo);
    await git(["bundle", "create", bundle, "refs/heads/orloom-candidate", `^${baseSha}`], repo);
    await git(["bundle", "verify", bundle], repo);
    const heads = await git(["bundle", "list-heads", bundle], repo);
    assert(heads.split(/\r?\n/).some(line => line.trim().split(/\s+/)[0]?.toLowerCase() === candidateSha.toLowerCase()));
    assert((await readFile(bundle)).byteLength > 0);
    await git(["init", "--bare", "--quiet", receiver], root);
    await git(["--git-dir", receiver, "fetch", "--quiet", repo, baseSha], root);
    await git(["--git-dir", receiver, "fetch", "--quiet", bundle, "refs/heads/orloom-candidate"], root);
    assert.equal(await git(["--git-dir", receiver, "rev-parse", "FETCH_HEAD"], root), candidateSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
