#!/usr/bin/env node
// Verify one immutable source commit from a fresh native checkout. Run from the
// repository root: node docs/validation/slice1c-review-findings/verify-1c.mjs <commit> <new-output-dir>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runGit = (repo, args, options = {}) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: null, maxBuffer: 1 << 28, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr?.toString("utf8") ?? ""}`);
  return result.stdout;
};

function committedBlob(repo, commit, relativePath) {
  if (relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`unsafe committed path: ${relativePath}`);
  }
  try { return runGit(repo, ["show", `${commit}:${relativePath}`]); }
  catch (error) { throw new Error(`missing committed blob ${commit}:${relativePath}`, { cause: error }); }
}

export function verifyArtifactManifest(repo, commit, manifestPath) {
  const manifest = committedBlob(repo, commit, manifestPath).toString("utf8");
  const manifestDir = path.posix.dirname(manifestPath);
  const entries = [];
  const seen = new Set();
  for (const [index, line] of manifest.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([a-f0-9]{64})  ([^\s]+)$/.exec(line);
    if (!match) throw new Error(`${manifestPath}:${index + 1}: malformed hash entry`);
    const [, expected, name] = match;
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || seen.has(name)) {
      throw new Error(`${manifestPath}:${index + 1}: unsafe or duplicate artifact path`);
    }
    seen.add(name);
    const artifactPath = manifestDir === "." ? name : `${manifestDir}/${name}`;
    const actual = sha256(committedBlob(repo, commit, artifactPath));
    if (actual !== expected) throw new Error(`${artifactPath}: hash mismatch expected=${expected} actual=${actual}`);
    entries.push({ path: artifactPath, sha256: actual });
  }
  if (entries.length === 0) throw new Error(`${manifestPath}: no artifacts are listed`);
  return entries;
}

export function verifyManifests(repo, commit, manifestPaths) {
  if (!Array.isArray(manifestPaths) || manifestPaths.length === 0) throw new Error("at least one artifact manifest is required");
  return manifestPaths.map(manifest => ({ manifest, entries: verifyArtifactManifest(repo, commit, manifest) }));
}

export function materializeCommit(sourceRepo, commit, parent = os.tmpdir()) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("commit must be a full object ID");
  runGit(sourceRepo, ["cat-file", "-e", `${commit}^{commit}`]);
  const root = mkdtempSync(path.join(parent, "orloom-1c-"));
  const checkout = path.join(root, "source");
  try {
    runGit(sourceRepo, ["clone", "--local", "--no-hardlinks", "--no-checkout", "--", sourceRepo, checkout]);
    runGit(checkout, ["checkout", "--detach", commit]);
    const actual = runGit(checkout, ["rev-parse", "HEAD"]).toString("utf8").trim();
    if (actual !== commit) throw new Error(`checkout mismatch: expected=${commit} actual=${actual}`);
    return { root, checkout };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function commandResult(cwd, command, args, outputDir, index) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, env: process.env });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}\n` : ""}`;
  const name = `${String(index).padStart(2, "0")}-${command.replace(/[^a-z0-9-]/gi, "_")}-${args[0]?.replace(/[^a-z0-9-]/gi, "_") ?? "run"}.log`;
  writeFileSync(path.join(outputDir, name), log);
  const record = { command: [command, ...args], exitCode: result.status ?? 127, durationMs: Number(durationMs.toFixed(2)), log: name, logSha256: sha256(log) };
  console.log(`${record.exitCode === 0 ? "PASS" : "FAIL"} ${record.command.join(" ")} exit=${record.exitCode} durationMs=${record.durationMs} logSha256=${record.logSha256}`);
  return { record, error: result.error };
}

function verifyMode(sourceCommit, outputArg) {
  if (os.platform() !== "linux") throw new Error(`native Linux is required, found ${os.platform()}`);
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(`Node.js >=24 is required, found ${process.version}`);
  const startedAt = new Date().toISOString();
  const sourceRepo = process.cwd();
  const outputDir = path.resolve(sourceRepo, outputArg);
  if (outputDir === sourceRepo || !outputDir.startsWith(`${sourceRepo}${path.sep}`)) throw new Error("output directory must be a new path inside the caller repository");
  mkdirSync(outputDir, { recursive: false });
  const { root, checkout } = materializeCommit(sourceRepo, sourceCommit);
  const commands = [];
  const runAndRecord = (command, args, index) => {
    const { record, error } = commandResult(checkout, command, args, outputDir, index);
    commands.push(record);
    if (error) throw error;
    if (record.exitCode !== 0) throw new Error(`${record.command.join(" ")} failed with exit ${record.exitCode}; see ${path.join(outputDir, record.log)}`);
  };
  try {
    const checkedOut = runGit(checkout, ["rev-parse", "HEAD"]).toString("utf8").trim();
    const manifestPaths = [
      "docs/validation/slice0-baseline/artifact-sha256.txt",
      "docs/validation/slice1a-runtime-intent/artifact-sha256.txt",
      "docs/validation/slice1b-owner-cancellation/artifact-sha256.txt",
      "docs/validation/slice1c-review-findings/artifact-sha256.txt",
    ];
    manifestPaths.push("PR23-source-sha256.txt");
    const integrity = verifyManifests(checkout, sourceCommit, manifestPaths);
    console.log(`materialized committed source ${checkedOut} at ${checkout}`);
    console.log(`committed artifact manifests: ${integrity.map(row => `${row.manifest} ${row.entries.length}/${row.entries.length}`).join("; ")}`);

    runAndRecord("npm", ["ci", "--no-audit", "--no-fund"], 1);
    runAndRecord("npm", ["run", "typecheck"], 2);
    runAndRecord("npm", ["run", "build"], 3);
    runAndRecord("npm", ["run", "validate"], 4);
    runAndRecord("node", ["--test", "tests/slice1c-verifier.test.mjs"], 5);

    const focused = [
      "dist/tests/runtime-journal-review-findings.test.js",
      "dist/tests/runtime-journal.test.js",
      "dist/tests/runtime-intent-persistence.test.js",
      "dist/tests/runtime-cancellation.test.js",
      "dist/tests/runtime-claim-regressions.test.js",
      "dist/tests/missions.test.js",
    ];
    for (const file of focused) if (!readdirSync(path.join(checkout, "dist/tests")).includes(path.basename(file))) throw new Error(`required focused test is missing: ${file}`);
    runAndRecord("node", ["--test", ...focused], 6);
    runAndRecord("npm", ["test"], 7);

    const finishedAt = new Date().toISOString();
    const files = readdirSync(outputDir).filter(name => name.endsWith(".log")).sort().map(name => ({ name, sha256: sha256(readFileSync(path.join(outputDir, name))) }));
    const receipt = { schema: "orloom.slice1c.source-verification.v1", sourceCommit, checkedOutCommit: checkedOut, startedAt, finishedAt, platform: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version, npm: commandVersion(checkout) }, integrity, commands, logArtifacts: files, status: "PASS" };
    writeFileSync(path.join(outputDir, "source-verification.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`source verification PASS; receipt ${path.join(outputDir, "source-verification.json")}`);
  } catch (error) {
    const failed = { schema: "orloom.slice1c.source-verification.v1", sourceCommit, startedAt, finishedAt: new Date().toISOString(), status: "FAIL", error: String(error), completedCommands: commands, failureLogFiles: readdirSync(outputDir).filter(name => name.endsWith(".log")).sort().map(name => ({ name, sha256: sha256(readFileSync(path.join(outputDir, name))) })) };
    writeFileSync(path.join(outputDir, "source-verification-failure.json"), `${JSON.stringify(failed, null, 2)}\n`);
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function commandVersion(repo) {
  const result = spawnSync("npm", ["--version"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`npm --version failed (${result.status})`);
  return result.stdout.trim();
}

function integrityMode(commit, manifests) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("commit must be a full object ID");
  const repo = process.cwd();
  runGit(repo, ["cat-file", "-e", `${commit}^{commit}`]);
  for (const { manifest, entries } of verifyManifests(repo, commit, manifests)) {
    console.log(`${manifest}: ${entries.length}/${entries.length} committed blobs match at ${commit}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--integrity") integrityMode(process.argv[3], process.argv.slice(4));
    else if (process.argv.length === 4) verifyMode(process.argv[2], process.argv[3]);
    else throw new Error("usage: verify-1c.mjs <full-source-commit> <new-output-dir> | --integrity <full-receipt-commit> <manifest-path> [...]");
  } catch (error) {
    console.error(`verification failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
