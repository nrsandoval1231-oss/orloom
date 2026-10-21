import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyWorkerSnapshot, collectWorkerInputFiles, type WorkerSnapshot } from "../apps/worker/src/docker-runtime.js";
import { executionInputProfileForRepository } from "../packages/verification/src/repository.js";

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

async function fixture(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(path.join(tmpdir(), "orloom-worker-input-"));
  await git(["init", "--quiet"], root);
  await git(["config", "user.name", "Orloom Test"], root);
  await git(["config", "user.email", "worker@orloom.invalid"], root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(["add", "--all"], root);
  await git(["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"], root);
  return root;
}

function excludedHistory() {
  return Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
    `docs/validation/part-${i + 1}.txt`, Buffer.alloc(900_000, 0x61 + i),
  ]));
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const changed = (file: string, bytes: string): WorkerSnapshot["changed"][number] => {
  const data = Buffer.from(bytes);
  return { path: file, bytesBase64: data.toString("base64"), sha256: sha(data) };
};

async function workerFixture() {
  return fixture({
    "apps/control-plane/source.ts": "original source\n",
    "deploy/hostinger/init-secrets.sh": "#!/bin/sh\n# retained bootstrap\n",
    "docs/validation/historical.md": "retained evidence\n",
  });
}

test("worker snapshot projects the finite profile and omits bootstrap without reading excluded history", async () => {
  const root = await fixture({
    "apps/control-plane/source.ts": "source\n",
    "deploy/hostinger/init-secrets.sh": "#!/bin/sh\n# generates secrets at runtime\n",
    ...excludedHistory(),
  });
  try {
    const files = await collectWorkerInputFiles(root, "orloom-execution-v1");
    assert.deepEqual(files.map(row => row.path), ["apps/control-plane/source.ts"]);
    assert.equal(Buffer.from(files[0]!.bytesBase64, "base64").toString(), "source\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("projection stays disabled unless the operator repository profile is supplied", async () => {
  const root = await workerFixture();
  try {
    assert.equal(executionInputProfileForRepository({ objectStore: "C:/private/repo.git", approvedRef: "refs/heads/main" }), undefined);
    const operatorProfile = executionInputProfileForRepository({ objectStore: "C:/private/repo.git", approvedRef: "refs/heads/main", executionInputProfile: "orloom-execution-v1" });
    assert.equal(operatorProfile, "orloom-execution-v1");
    assert.throws(() => executionInputProfileForRepository({ executionInputProfile: "candidate-patterns" }), /unknown execution input profile/);
    await assert.rejects(collectWorkerInputFiles(root), /Secret-bearing file name/);
    assert.deepEqual((await collectWorkerInputFiles(root, operatorProfile)).map(row => row.path), ["apps/control-plane/source.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("excluded historical corpus does not count toward worker transfer bytes", async () => {
  const root = await fixture({
    "apps/control-plane/source.ts": "source\n",
    ...excludedHistory(),
  });
  try {
    const files = await collectWorkerInputFiles(root, "orloom-execution-v1");
    assert.deepEqual(files.map(row => row.path), ["apps/control-plane/source.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("whole-tree forbidden paths and unknown roots fail even when excluded", async () => {
  const forbidden = await fixture({
    "apps/control-plane/source.ts": "source\n",
    "docs/validation/.github/workflows/forbidden.yml": "name: forbidden\n",
  });
  const unknown = await fixture({ "mystery/input.txt": "unknown root\n" });
  try {
    await assert.rejects(collectWorkerInputFiles(forbidden, "orloom-execution-v1"), /forbidden workflow, credential, or dependency path/);
    await assert.rejects(collectWorkerInputFiles(unknown, "orloom-execution-v1"), /unclassified execution input path/);
  } finally {
    await rm(forbidden, { recursive: true, force: true });
    await rm(unknown, { recursive: true, force: true });
  }
});

test("selected secret-like bytes and sensitive filenames remain rejected", async () => {
  const bytes = await fixture({ "apps/control-plane/source.ts": `const token = "ghp_${"A".repeat(36)}";\n` });
  const filename = await fixture({ "apps/control-plane/.git-credentials": "safe-looking content\n" });
  try {
    await assert.rejects(collectWorkerInputFiles(bytes, "orloom-execution-v1"), /Secret-like material detected/);
    await assert.rejects(collectWorkerInputFiles(filename, "orloom-execution-v1"), /Secret-bearing file name/);
  } finally {
    await rm(bytes, { recursive: true, force: true });
    await rm(filename, { recursive: true, force: true });
  }
});

test("selected worker input keeps the unchanged per-file and total byte caps", async () => {
  const oversized = await fixture({ "apps/control-plane/source.ts": Buffer.alloc(1_000_001, 0x61) });
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
    `apps/control-plane/part-${i + 1}.txt`, Buffer.alloc(900_000, 0x61 + i),
  ]));
  const overTotal = await fixture(files);
  try {
    await assert.rejects(collectWorkerInputFiles(oversized, "orloom-execution-v1"), /Selected worker input file exceeds transfer limits/);
    await assert.rejects(collectWorkerInputFiles(overTotal, "orloom-execution-v1"), /worker transfer limits/);
  } finally {
    await rm(oversized, { recursive: true, force: true });
    await rm(overTotal, { recursive: true, force: true });
  }
});

test("tracked symlinks, gitlinks, and case-colliding paths fail before input selection", async () => {
  const symlink = await fixture({ "apps/control-plane/source.ts": "source\n" });
  const gitlink = await fixture({ "apps/control-plane/source.ts": "source\n" });
  const collision = await fixture({ "apps/control-plane/Foo.ts": "source\n" });
  try {
    const blob = await git(["hash-object", "apps/control-plane/source.ts"], symlink);
    await git(["update-index", "--add", "--cacheinfo", `120000,${blob},apps/control-plane/link`], symlink);
    await assert.rejects(collectWorkerInputFiles(symlink, "orloom-execution-v1"), /symlink, gitlink, conflict/);

    const commit = await git(["rev-parse", "HEAD"], gitlink);
    await git(["update-index", "--add", "--cacheinfo", `160000,${commit},apps/control-plane/submodule`], gitlink);
    await assert.rejects(collectWorkerInputFiles(gitlink, "orloom-execution-v1"), /symlink, gitlink, conflict/);

    const caseBlob = await git(["hash-object", "apps/control-plane/Foo.ts"], collision);
    await git(["-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${caseBlob},apps/control-plane/foo.ts`], collision);
    await assert.rejects(collectWorkerInputFiles(collision, "orloom-execution-v1"), /case-colliding paths/);
  } finally {
    await rm(symlink, { recursive: true, force: true });
    await rm(gitlink, { recursive: true, force: true });
    await rm(collision, { recursive: true, force: true });
  }
});

test("worker projection retains the original Git tree while applying only scoped selected edits", async () => {
  const root = await workerFixture();
  try {
    const files = await collectWorkerInputFiles(root, "orloom-execution-v1");
    assert.deepEqual(files.map(row => row.path), ["apps/control-plane/source.ts"]);
    const bootstrap = await git(["rev-parse", "HEAD:deploy/hostinger/init-secrets.sh"], root);
    const history = await git(["rev-parse", "HEAD:docs/validation/historical.md"], root);
    const selected = changed("apps/control-plane/source.ts", "candidate source\n");

    await assert.rejects(applyWorkerSnapshot(root, { changed: [selected, changed("docs/validation/new.txt", "blocked\n")], removed: [] }, ["apps/control-plane/**", "docs/validation/**"], "orloom-execution-v1"), /excluded worker input path/);
    assert.equal(await git(["hash-object", "apps/control-plane/source.ts"], root), await git(["rev-parse", "HEAD:apps/control-plane/source.ts"], root));
    assert.equal(await git(["rev-parse", "HEAD:deploy/hostinger/init-secrets.sh"], root), bootstrap);
    assert.equal(await git(["rev-parse", "HEAD:docs/validation/historical.md"], root), history);

    await assert.rejects(applyWorkerSnapshot(root, { changed: [selected], removed: ["deploy/hostinger/init-secrets.sh"] }, ["apps/control-plane/**", "deploy/**"], "orloom-execution-v1"), /excluded worker input path/);
    assert.equal(await git(["rev-parse", "HEAD:deploy/hostinger/init-secrets.sh"], root), bootstrap);

    const touched = await applyWorkerSnapshot(root, { changed: [selected], removed: [] }, ["apps/control-plane/**"], "orloom-execution-v1");
    assert.deepEqual(touched, ["apps/control-plane/source.ts"]);
    assert.equal(sha(await readFile(path.join(root, "apps/control-plane/source.ts"))), selected.sha256);
    await git(["add", "--", ":(literal)apps/control-plane/source.ts"], root);
    await git(["commit", "--quiet", "--no-gpg-sign", "-m", "candidate"], root);
    assert.equal(await git(["rev-parse", "HEAD:deploy/hostinger/init-secrets.sh"], root), bootstrap);
    assert.equal(await git(["rev-parse", "HEAD:docs/validation/historical.md"], root), history);
    assert.equal(await git(["show", "HEAD:apps/control-plane/source.ts"], root), "candidate source");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshot validates every row before host mutation and rejects new excluded descendants", async () => {
  const root = await workerFixture();
  try {
    const before = await git(["rev-parse", "HEAD:apps/control-plane/source.ts"], root);
    await assert.rejects(applyWorkerSnapshot(root, {
      changed: [changed("apps/control-plane/source.ts", "must not be written\n"), changed("deploy/hostinger/init-secrets.sh/new.txt", "blocked\n")],
      removed: [],
    }, ["apps/control-plane/**", "deploy/**"], "orloom-execution-v1"), /excluded worker input path/);
    assert.equal(await git(["hash-object", "apps/control-plane/source.ts"], root), before);
    assert.equal(await git(["status", "--porcelain"], root), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshot rejects case-only output aliases before touching the tracked file", async () => {
  const root = await workerFixture();
  try {
    const before = await git(["rev-parse", "HEAD:apps/control-plane/source.ts"], root);
    await assert.rejects(applyWorkerSnapshot(root, {
      changed: [changed("apps/CONTROL-PLANE/SOURCE.ts", "case alias\n")], removed: [],
    }, ["apps/**"], "orloom-execution-v1"), /case-colliding path/);
    assert.equal(await git(["hash-object", "apps/control-plane/source.ts"], root), before);
    assert.equal(await git(["status", "--porcelain"], root), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sandbox RPC creates new files exclusively and snapshots them for exact host application", { skip: process.platform !== "linux" && "sandbox-entry uses Linux filesystem semantics" }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orloom-create-file-rpc-"));
  const workspace = path.join(temp, "tree");
  await mkdir(workspace);
  const source = await readFile(new URL("../apps/worker/src/sandbox-entry.js", import.meta.url), "utf8");
  const script = path.join(temp, "sandbox-entry.js");
  await writeFile(script, source.replace('const root = "/work/tree";', `const root = ${JSON.stringify(workspace)};`));
  try {
    const input = [
      { id: "init", op: "init", files: [
        { path: "apps/control-plane/source.ts", bytesBase64: Buffer.from("source\n").toString("base64"), sha256: sha(Buffer.from("source\n")) },
        { path: "existing.ts", bytesBase64: Buffer.from("existing").toString("base64"), sha256: sha(Buffer.from("existing")) },
        { path: "not-a-dir", bytesBase64: Buffer.from("regular file").toString("base64"), sha256: sha(Buffer.from("regular file")) }
      ], checks: {} },
      { id: "create", op: "create_file", path: "apps/control-plane/new.ts", text: "export const draft = true;\n" },
      { id: "empty", op: "create_file", path: "apps/control-plane/empty.ts", text: "" },
      { id: "traversal", op: "create_file", path: "../escape.ts", text: "bad" },
      { id: "duplicate", op: "create_file", path: "apps/control-plane/new.ts", text: "overwrite" },
      { id: "case", op: "create_file", path: "apps/CONTROL-PLANE/NEW.ts", text: "alias" },
      { id: "existing", op: "create_file", path: "existing.ts", text: "overwrite" },
      { id: "non-directory", op: "create_file", path: "not-a-dir/child.ts", text: "bad" },
      { id: "oversized", op: "create_file", path: "large.ts", text: "x".repeat(8_001) },
      { id: "snapshot", op: "snapshot" }
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    const stdout = execFileSync(process.execPath, [script], { input, encoding: "utf8", timeout: 10_000 });
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as { id: string; ok: boolean; value?: unknown; error?: string });
    assert.deepEqual(replies.map(reply => reply.id), ["init", "create", "empty", "traversal", "duplicate", "case", "existing", "non-directory", "oversized", "snapshot"]);
    assert.equal(replies[1]?.ok, true, replies[1]?.error);
    for (const reply of replies.slice(2, 9)) assert.equal(reply.ok, false, `${reply.id} must be rejected`);
    const snapshot = replies[9]?.value as WorkerSnapshot;
    assert.deepEqual(snapshot.changed.map(row => row.path).sort(), ["apps/control-plane/new.ts"]);
    assert.equal(Buffer.from(snapshot.changed[0]!.bytesBase64, "base64").toString(), "export const draft = true;\n");
    const linkWorkspace = path.join(temp, "linked-tree");
    const outside = path.join(temp, "outside");
    await mkdir(linkWorkspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "target"), "outside");
    await symlink(outside, path.join(linkWorkspace, "linked-dir"), "dir");
    await symlink(path.join(outside, "target"), path.join(linkWorkspace, "linked-leaf"), "file");
    const linkScript = path.join(temp, "sandbox-links.js");
    await writeFile(linkScript, source.replace('const root = "/work/tree";', `const root = ${JSON.stringify(linkWorkspace)};`));
    const linkInput = [
      { id: "init", op: "init", files: [], checks: {} },
      { id: "parent", op: "create_file", path: "linked-dir/escape.ts", text: "bad" },
      { id: "leaf", op: "create_file", path: "linked-leaf", text: "bad" },
      { id: "close", op: "close" }
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    const linkReplies = execFileSync(process.execPath, [linkScript], { input: linkInput, encoding: "utf8", timeout: 10_000 }).trim().split("\n").map(line => JSON.parse(line) as { id: string; ok: boolean });
    assert.equal(linkReplies[0]?.ok, true);
    assert.equal(linkReplies[1]?.ok, false, "symlink parent is refused");
    assert.equal(linkReplies[2]?.ok, false, "symlink leaf is refused");
    assert.equal(linkReplies[3]?.ok, true);
    const root = await workerFixture();
    try {
      const touched = await applyWorkerSnapshot(root, snapshot, ["apps/control-plane/**"], "orloom-execution-v1");
      assert.deepEqual(touched, ["apps/control-plane/new.ts"]);
      assert.equal(await readFile(path.join(root, "apps/control-plane/new.ts"), "utf8"), "export const draft = true;\n");
      await assert.rejects(applyWorkerSnapshot(root, snapshot, ["apps/control-plane/**"], "orloom-execution-v1"), /unsupported type|case-colliding path|already exists|output/i);
      assert.equal(await readFile(path.join(root, "apps/control-plane/new.ts"), "utf8"), "export const draft = true;\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
