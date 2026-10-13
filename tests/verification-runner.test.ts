import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile, copyFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DurableArtifactStore } from "../packages/verification/src/artifact-store.js";
import { extractCandidateBundle } from "../packages/verification/src/repository.js";
import { getCheckAttemptLifetimeMs, getCheckPolicy, NODE_REPO_SUITE_BINDING } from "../packages/verification/src/policy.js";
import { TRUSTED_CHECK_LIMITS } from "../packages/contracts/src/verification.js";
import { classifyLauncherOutput, retainSuiteDiagnostics } from "../packages/verification/src/runsc-launcher.js";

const exec = promisify(execFile);
async function git(dir: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", dir, "-c", "user.name=Verifier Fixture", "-c", "user.email=fixture@example.invalid", ...args], { windowsHide: true });
}
async function resolveManifestFiles(manifestPath: string, trackedFiles: () => Promise<Array<{ path: string; bytes: number; sha256: string }>>) {
  try { return JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8")).files; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return trackedFiles(); }
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
  for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty"]) assert.throws(() => getCheckPolicy(inherited), /finite policy/);
});

test("repository suite is a separate trusted policy bound to the reviewed lock and fixed profile", async () => {
  const suite = getCheckPolicy("node-repo-suite-v1");
  assert.equal(suite.version, "orloom.node-repo-suite.v3");
  assert.deepEqual(suite.argv, ["/usr/local/bin/node", "/opt/orloom-verifier/run-check.js"]);
  assert.equal(suite.timeoutMs, 225_000);
  assert.equal(suite.maxConcurrent, 1);
  assert.equal(suite.digest, getCheckPolicy("node-repo-suite-v1").digest);
  assert.notEqual(suite.digest, getCheckPolicy("node-validate-syntax").digest);
  assert.throws(() => getCheckPolicy("worker supplied npm test"), /finite policy/);
  assert.equal(NODE_REPO_SUITE_BINDING.resources.pids, 128);
  assert.equal(NODE_REPO_SUITE_BINDING.resources.workTmpfsBytes, 512 * 1024 * 1024);
  assert.deepEqual(NODE_REPO_SUITE_BINDING.timeouts, { suiteExecutionMs: 180_000, dockerAttachMs: 210_000, hostLauncherMs: 225_000, attemptLifetimeMs: 240_000 });
  assert.ok(NODE_REPO_SUITE_BINDING.timeouts.suiteExecutionMs < NODE_REPO_SUITE_BINDING.timeouts.dockerAttachMs);
  assert.ok(NODE_REPO_SUITE_BINDING.timeouts.dockerAttachMs < NODE_REPO_SUITE_BINDING.timeouts.hostLauncherMs);
  assert.ok(NODE_REPO_SUITE_BINDING.timeouts.hostLauncherMs < NODE_REPO_SUITE_BINDING.timeouts.attemptLifetimeMs);
  assert.equal(getCheckAttemptLifetimeMs("node-repo-suite-v1"), 240_000);
  assert.equal(getCheckAttemptLifetimeMs("node-validate-syntax"), 60_000);
  assert.ok(getCheckAttemptLifetimeMs("node-repo-suite-v1") < TRUSTED_CHECK_LIMITS.maxLifetimeMs);
  assert.throws(() => getCheckAttemptLifetimeMs("worker supplied timeout"), /finite policy/);
  assert.deepEqual(NODE_REPO_SUITE_BINDING.diagnostics, { protocol: "orloom.suite-diagnostics.v3", maxFrames: 64, maxBytes: 16_384, maxElapsedMs: 180_000, maxTestOrdinal: 64, maxTestFileNameBytes: 128, authority: "advisory-only" });
  assert.equal(getCheckPolicy("node-validate-syntax").timeoutMs, 60_000);
  assert.equal(getCheckPolicy("node-validate-syntax").digest, "e94f014eafb1763402f210b4bd0218f3807aa9e6ca74ccaeda988661670c5cbe", "suite deadline changes do not alter syntax policy meaning or digest");
  const { ADMITTED_DEPENDENCIES } = await import(pathToFileURL(path.join(process.cwd(), "infra/verifier-isolation/suite-policy.js")).href);
  assert.equal(ADMITTED_DEPENDENCIES["package.json"], NODE_REPO_SUITE_BINDING.dependencies.packageJsonSha256);
  assert.equal(ADMITTED_DEPENDENCIES["package-lock.json"], NODE_REPO_SUITE_BINDING.dependencies.packageLockSha256);
  const { readFile } = await import("node:fs/promises");
  const runner = await readFile("infra/verifier-isolation/run-repo-suite.js", "utf8");
  const orderSource = runner.match(/const POLICY_STAGE_ORDER = Object\.freeze\((\[[^\]]+\])\)/)?.[1];
  assert.ok(orderSource); assert.deepEqual(JSON.parse(orderSource), NODE_REPO_SUITE_BINDING.stages.map(stage => stage.name));
  const isolation = await readFile("infra/verifier-isolation/launch-verifier.sh", "utf8");
  for (const bound of ["echo 128", "echo 1g", "echo 512m", "--network=none", "--read-only"]) assert(isolation.includes(bound), `launcher retains ${bound}`);
  assert.match(isolation, /echo 210s \|\| echo 60s/);
  const suiteRunner = await readFile("infra/verifier-isolation/run-repo-suite.js", "utf8");
  assert.match(suiteRunner, /const limit = 180_000/);
  assert.match(suiteRunner, /runSerialTestFiles\(tests/);
  const dockerfile = await readFile("infra/verifier-isolation/Dockerfile", "utf8");
  assert(dockerfile.includes("/root/.nvm/versions/node/v24.15.0/lib/node_modules/npm"));
  assert.match(dockerfile, /npm-cli\.js ci --include=dev --ignore-scripts/);
});

test("repository suite runs every discovered test file serially and binds the new policy digest", async () => {
  const suite = getCheckPolicy("node-repo-suite-v1");
  const syntax = getCheckPolicy("node-validate-syntax");
  const nodeTests = NODE_REPO_SUITE_BINDING.stages.find(stage => stage.name === "node-tests");
  assert.deepEqual(nodeTests?.argv, ["for each trusted sorted discovered *.test.js: /usr/local/bin/node --test --test-concurrency=1 dist/tests/<basename>"]);
  assert.notEqual(suite.digest, "509afb5e1497729e1a99e8b5309599fd6025208336e7b838465a0b3194bf980d", "serial fan-out must change the previously reviewed suite digest");
  assert.equal(syntax.digest, "e94f014eafb1763402f210b4bd0218f3807aa9e6ca74ccaeda988661670c5cbe", "suite concurrency must not change syntax-check policy");

  const { discoverSuiteTests } = await import(pathToFileURL(path.join(process.cwd(), "infra/verifier-isolation/suite-policy.js")).href);
  const { readdir, readFile } = await import("node:fs/promises");
  const tests = discoverSuiteTests(await readdir(path.join(process.cwd(), "dist/tests")));
  assert.ok(tests.length > 0, "the clean build must discover the complete test suite");
  assert.deepEqual(tests, [...tests].sort(), "discovery returns every test filename in stable sorted order");
  const commands = tests.map(file => ["--test", "--test-concurrency=1", `dist/tests/${file}`]);
  assert.equal(commands.length, tests.length);
  assert.deepEqual(commands.map(command => command[2]), tests.map(file => `dist/tests/${file}`), "each discovered test gets one serial invocation in stable order");
  const runner = await readFile("infra/verifier-isolation/run-repo-suite.js", "utf8");
  assert.match(runner, /runSerialTestFiles\(tests/);
});

test("production serial test runner executes trusted files in order and stops fail-closed", async () => {
  const { runSerialTestFiles } = await import(pathToFileURL(path.join(process.cwd(), "infra/verifier-isolation/stage-runner.js")).href);
  const fileNames = ["a.test.js", "b.test.js", "c.test.js"];
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const pass = () => ({ exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), truncated: false });
  const success = await runSerialTestFiles(fileNames, {
    cwd: "/work/source", env: {}, remainingMs: () => 1000,
    run: async (_bin: string, args: string[], options: { timeoutMs: number }) => { calls.push({ file: args[2]!, args, timeoutMs: options.timeoutMs }); return pass(); },
  });
  assert.equal(success.exitCode, 0);
  assert.deepEqual(calls.map(call => call.file), fileNames.map(file => `dist/tests/${file}`));
  assert(calls.every(call => JSON.stringify(call.args) === JSON.stringify(["--test", "--test-concurrency=1", call.file])));
  assert(calls.every(call => call.timeoutMs === 1000));

  for (const result of [
    { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false },
    { exitCode: null, timedOut: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false },
  ]) {
    const attempted: string[] = [];
    const stopped = await runSerialTestFiles(fileNames, {
      cwd: "/work/source", env: {}, remainingMs: () => 1000,
      run: async (_bin: string, args: string[]) => { attempted.push(args[2]!); return result; },
    });
    assert.equal(attempted.length, 1, "FAIL and UNKNOWN stop subsequent file invocations");
    assert.equal(stopped.exitCode, result.exitCode);
  }

  const lateCalls: string[] = []; let deadlineChecks = 0;
  const latePass = await runSerialTestFiles(fileNames, {
    cwd: "/work/source", env: {}, remainingMs: () => ++deadlineChecks < 3 ? 100 : 0,
    run: async (_bin: string, args: string[]) => { lateCalls.push(args[2]!); return pass(); },
  });
  assert.equal(lateCalls.length, 1);
  assert.equal(latePass.exitCode, null, "a result that arrives after the shared deadline becomes UNKNOWN");
  assert.equal(latePass.timedOut, true);

  const largeCalls: string[] = [];
  const overflow = await runSerialTestFiles(fileNames, {
    cwd: "/work/source", env: {}, remainingMs: () => 1000, maxLogBytes: 65_536,
    run: async (_bin: string, args: string[]) => { largeCalls.push(args[2]!); return { ...pass(), stdout: Buffer.alloc(40_000) }; },
  });
  assert.equal(largeCalls.length, 2);
  assert.equal(overflow.exitCode, null);
  assert.equal(overflow.truncated, true, "combined logs remain capped at 65,536 bytes and fail closed");

  const manyFiles = Array.from({ length: 65 }, (_, index) => `suite-${String(index + 1).padStart(3, "0")}.test.js`);
  const manyCalls: string[] = [], emittedOrdinals: number[] = [];
  const many = await runSerialTestFiles(manyFiles, {
    cwd: "/work/source", env: {}, remainingMs: () => 1000,
    emit: (frame: { ordinal: number }) => { if (frame.ordinal <= 64) emittedOrdinals.push(frame.ordinal); return frame.ordinal <= 64; },
    run: async (_bin: string, args: string[]) => { manyCalls.push(args[2]!); return pass(); },
  });
  assert.equal(many.exitCode, 0);
  assert.equal(manyCalls.length, 65, "the telemetry ordinal cap never limits test selection or execution");
  assert.deepEqual(manyCalls, manyFiles.map(file => `dist/tests/${file}`));
  assert.equal(emittedOrdinals.includes(65), false);
});

test("verifier image installs with two isolated npm config files", async () => {
  const dockerfile = await readFile("infra/verifier-isolation/Dockerfile", "utf8");
  const userConfig = dockerfile.match(/--userconfig=(\/opt\/orloom-verifier\/npm-config\/[^\s\\]+)/)?.[1];
  const globalConfig = dockerfile.match(/--globalconfig=(\/opt\/orloom-verifier\/npm-config\/[^\s\\]+)/)?.[1];
  assert.ok(userConfig, "image supplies a trusted empty user config");
  assert.ok(globalConfig, "image supplies a trusted empty global config");
  assert.notEqual(userConfig, globalConfig, "npm must not load one config as both user and global");
  assert.match(dockerfile, new RegExp(`: > ${userConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(dockerfile, new RegExp(`: > ${globalConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(dockerfile, /--(?:user|global)config=\/dev\/null/);
});

test("local npm accepts distinct sanitized config paths", { skip: ![
  process.env.npm_execpath,
  "/opt/orloom-verifier/npm/bin/npm-cli.js",
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
].filter((candidate): candidate is string => typeof candidate === "string").some(existsSync) }, async () => {
  const npmCliCandidates = [
    process.env.npm_execpath,
    "/opt/orloom-verifier/npm/bin/npm-cli.js",
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npmCli = npmCliCandidates.find(existsSync);
  assert.ok(npmCli);
  const root = await mkdtemp(path.join(os.tmpdir(), "orl-npm-config-"));
  try {
    const user = path.join(root, "trusted-user.npmrc");
    const global = path.join(root, "trusted-global.npmrc");
    await Promise.all([writeFile(user, ""), writeFile(global, "")]);
    const env = { HOME: root, PATH: process.env.PATH ?? "", USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
    const args = [npmCli, "config", "get", "userconfig", `--userconfig=${user}`, `--globalconfig=${global}`];
    const { stdout } = await exec(process.execPath, args, { cwd: root, env, windowsHide: true, encoding: "utf8" });
    assert.equal(stdout.trim(), user);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository suite admission accepts the exact dependency pair and rejects stale locks and overrides", async () => {
  const { ADMITTED_DEPENDENCIES, admitSuiteInput, verifySuiteInputUnchanged } = await import(pathToFileURL(path.join(process.cwd(), "infra/verifier-isolation/suite-policy.js")).href);
  const root = await mkdtemp(path.join(os.tmpdir(), "orl-suite-admission-"));
  try {
    for (const file of Object.keys(ADMITTED_DEPENDENCIES)) await copyFile(file, path.join(root, file));
    await admitSuiteInput(root, [{ path: "README.md" }, { path: ".env.example" }, { path: "package-lock.json" }]);
    const { readFile } = await import("node:fs/promises");
    const crypto = await import("node:crypto");
    const gitManifest = async () => {
      const { stdout: tracked } = await exec("git", ["ls-files", "-z"], { encoding: "utf8", windowsHide: true });
      return Promise.all(tracked.split("\0").filter(Boolean).map(async file => {
        const bytes = await readFile(file);
        return { path: file.replaceAll("\\", "/"), bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
      }));
    };
    const actualManifest = await resolveManifestFiles("/work/manifest.json", gitManifest);
    const fixtureManifestPath = path.join(root, "manifest.json");
    await writeFile(fixtureManifestPath, JSON.stringify({ files: [{ path: "fixture", bytes: 0, sha256: "0".repeat(64) }] }));
    assert.equal((await resolveManifestFiles(fixtureManifestPath, async () => { throw new Error("must not require Git in extracted sandbox"); }))[0].path, "fixture");
    assert.deepEqual(await resolveManifestFiles(path.join(root, "absent-manifest.json"), async () => [{ path: "checkout", bytes: 0, sha256: "0".repeat(64) }]), [{ path: "checkout", bytes: 0, sha256: "0".repeat(64) }]);
    await admitSuiteInput(root, actualManifest);
    await verifySuiteInputUnchanged(process.cwd(), actualManifest);
    await assert.rejects(admitSuiteInput(root, [{ path: "dist/stale.test.js" }]), /credential\/dependency configuration/);
    await writeFile(path.join(root, "README.md"), "fixture source");
    const manifest = [{ path: "README.md", bytes: 14, sha256: (await import("node:crypto")).createHash("sha256").update("fixture source").digest("hex") }];
    await verifySuiteInputUnchanged(root, manifest);
    await writeFile(path.join(root, "README.md"), "candidate altered");
    await assert.rejects(verifySuiteInputUnchanged(root, manifest), /modified manifested input/);
    await assert.rejects(admitSuiteInput(root, []), /empty input/);
    await assert.rejects(admitSuiteInput(root, [{ path: ".github/workflows/check.yml" }]), /workflow/);
    for (const forbidden of ["src/secrets/token.json", "src/credentials.json", "state/run.db", "keys/signing.pfx", "src/.env.local", "src/node_modules/pkg/index.js", "src/.npmrc", "package-lock.json.bak"]) {
      await assert.rejects(admitSuiteInput(root, [{ path: forbidden }]), /credential\/dependency configuration/);
    }
    await writeFile(path.join(root, ".npmrc"), "registry=https://untrusted.invalid");
    await assert.rejects(admitSuiteInput(root, [{ path: "README.md" }]), /override/);
    await rm(path.join(root, ".npmrc"));
    await writeFile(path.join(root, "package-lock.json"), "changed");
    await assert.rejects(admitSuiteInput(root, [{ path: "README.md" }]), /differs from admitted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository suite requires discovered tests and treats failures, timeouts and truncation distinctly", async () => {
  const { discoverSuiteTests } = await import(pathToFileURL(path.join(process.cwd(), "infra/verifier-isolation/suite-policy.js")).href);
  const { classifySuiteStage, enforceSuiteDeadline, runStage, executeStages } = await import(pathToFileURL(path.join(process.cwd(), "infra/verifier-isolation/stage-runner.js")).href);
  assert.deepEqual(discoverSuiteTests(["x.js", "b.test.js", "a.test.js"]), ["a.test.js", "b.test.js"]);
  assert.deepEqual(discoverSuiteTests(["x.js"]), []);
  const root = await mkdtemp(path.join(os.tmpdir(), "orl-suite-stage-")), script = path.join(root, "fixture.mjs"), later = path.join(root, "later.txt");
  const run = (opts = {}) => runStage(process.execPath, [script], { cwd: root, timeoutMs: 5000, maxLogBytes: 128, env: process.env, ...opts });
  try {
    await writeFile(script, "process.stdout.write('ready')");
    let result = await run(); assert.equal(classifySuiteStage(result), "pass"); assert.equal(result.stdout.toString(), "ready");
    await writeFile(script, "process.exit(3)"); result = await run(); assert.equal(classifySuiteStage(result), "fail");
    await writeFile(script, "setInterval(() => {}, 1000)"); result = await run({ timeoutMs: 40 }); assert.equal(classifySuiteStage(result), "unknown"); assert.equal(result.timedOut, true);
    await writeFile(script, "process.stdout.write('x'.repeat(4096))"); result = await run(); assert.equal(classifySuiteStage(result), "unknown"); assert.equal(result.truncated, true);
    result = await runStage(path.join(root, "missing-executable"), [], { cwd: root, timeoutMs: 500, env: process.env }); assert.equal(classifySuiteStage(result), "unknown"); assert.equal(result.spawnError, true);
    await writeFile(script, "process.exit(2)");
    const stages = [
      { name: "fails", file: process.execPath, args: [script], cwd: root, env: process.env },
      { name: "must-not-run", file: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", later], cwd: root, env: process.env },
    ];
    const ran = await executeStages(stages, { remainingMs: () => 500 });
    assert.equal(ran.length, 1); assert.equal(ran[0].outcome, "fail");
    await assert.rejects(import("node:fs/promises").then(fs => fs.access(later)), { code: "ENOENT" });

    let callbackStarted = false, laterCallbackStarted = false, callbackBudget = 1;
    const late = await executeStages([
      { name: "late-final-callback", execute: async () => { callbackStarted = true; assert.ok(callbackBudget > 0, "callback starts within the remaining budget"); await Promise.resolve(); callbackBudget = -1; return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false }; } },
      { name: "must-not-run", execute: async () => { laterCallbackStarted = true; return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false }; } },
    ], { remainingMs: () => callbackBudget });
    assert.equal(callbackStarted, true);
    assert.equal(late.length, 1);
    assert.equal(late[0].outcome, "unknown", "a callback that returns after the whole-suite deadline cannot PASS");
    assert.equal(late[0].result.deadlineExceeded, true);
    assert.equal(laterCallbackStarted, false, "no later stage starts after a late final callback");
    const finalGuard = enforceSuiteDeadline({ exitCode: 0, truncated: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, () => -1);
    assert.equal(finalGuard.exitCode, null, "the marker-boundary guard converts any over-deadline result to UNKNOWN");
    assert.equal(classifySuiteStage(finalGuard), "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("launcher process-result fixtures reject infrastructure ambiguity and accept only matching check markers", async () => {
  const marker = (exitCode: number, truncated = false) => `ORLOOM-RESULT:${Buffer.from(JSON.stringify({ exitCode, truncated, stdoutBytes: 2, stderrBytes: 0, stdout: Buffer.from("ok").toString("base64"), stderr: "" })).toString("base64")}\n`;
  const pass = classifyLauncherOutput(marker(0), { exitCode: 0 }, 64);
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.stdout.toString(), "ok");
  const diagFrame = (phase: string, outcome?: string) => `ORLOOM-DIAG:v3:${Buffer.from(JSON.stringify({ version: "orloom.suite-diagnostics.v3", stage: "dependency-lock-admission", phase, elapsedMs: 5, ...(outcome ? { outcome } : {}) })).toString("base64")}\n`;
  const diagnosticsSayFail = `${diagFrame("start")}${diagFrame("end", "fail")}`;
  assert.equal(classifyLauncherOutput(`${diagnosticsSayFail}${marker(0)}`, { exitCode: 0 }, 64).exitCode, 0, "even a complete advisory FAIL frame cannot override the exact result marker and clean launcher exit");
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

test("UNKNOWN retains only bounded complete diagnostics from the trusted stage and file emitters", async () => {
  const script = `import { emitSuiteDiagnostic, emitSuiteTestDiagnostic } from './infra/verifier-isolation/suite-diagnostics.js';\nconst monotonicElapsed = Math.floor(performance.now());\nconst fractionalElapsed = monotonicElapsed + 0.5;\nfor (const value of [null, [], { stage: 'dependency-lock-admission', phase: 'end', elapsedMs: 180001, outcome: 'pass' }, { stage: 'dependency-lock-admission', phase: 'start', elapsedMs: NaN }, { stage: 'dependency-lock-admission', phase: 'end', elapsedMs: fractionalElapsed, outcome: 'pass' }]) if (emitSuiteDiagnostic(value) !== false) process.exitCode = 9;\nfor (const value of [{ phase: 'start', elapsedMs: 0, ordinal: 0, testFile: '../x.test.js' }, { phase: 'end', elapsedMs: 4, ordinal: 1, testFile: 'x.test.js', outcome: 'maybe' }]) if (emitSuiteTestDiagnostic(value) !== false) process.exitCode = 8;\nif (!emitSuiteDiagnostic({ stage: 'dependency-lock-admission', phase: 'start', elapsedMs: 0 })) process.exitCode = 10;\nif (!emitSuiteDiagnostic({ stage: 'dependency-lock-admission', phase: 'end', elapsedMs: monotonicElapsed, outcome: 'pass' })) process.exitCode = 11;\nif (!emitSuiteDiagnostic({ stage: 'typecheck', phase: 'start', elapsedMs: 0 })) process.exitCode = 12;\nif (!emitSuiteDiagnostic({ stage: 'typecheck', phase: 'end', elapsedMs: 60001, outcome: 'pass' })) process.exitCode = 13;\nfor (const stage of ['clean-build', 'test-discovery']) { if (!emitSuiteDiagnostic({ stage, phase: 'start', elapsedMs: 0 }) || !emitSuiteDiagnostic({ stage, phase: 'end', elapsedMs: 1, outcome: 'pass' })) process.exitCode = 14; }\nif (!emitSuiteDiagnostic({ stage: 'node-tests', phase: 'start', elapsedMs: 0 })) process.exitCode = 15;\nif (!emitSuiteTestDiagnostic({ phase: 'start', elapsedMs: 0, ordinal: 1, testFile: 'a.test.js' })) process.exitCode = 16;\nif (!emitSuiteTestDiagnostic({ phase: 'end', elapsedMs: 60001, ordinal: 1, testFile: 'a.test.js', outcome: 'pass' })) process.exitCode = 17;\nif (!emitSuiteDiagnostic({ stage: 'node-tests', phase: 'end', elapsedMs: monotonicElapsed, outcome: 'pass' })) process.exitCode = 18;\n`;
  const { stdout: emitted } = await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  assert.equal(emitted.split("\n").filter(Boolean).length, 12, "the actual trusted emitters produce fixed ordered stage and file frames");
  const unknown = classifyLauncherOutput(`${emitted}candidate secret output\nORLOOM-DIAG:v3:eyJwYXJ0aWFsIg`, { exitCode: null, timedOut: true, killed: true }, 16_384);
  assert.equal(unknown.exitCode, null);
  assert.equal(unknown.stdout.toString(), emitted);
  assert.equal(unknown.stderr.length, 0);
  assert.doesNotMatch(unknown.stdout.toString(), /candidate secret|partial/);
  assert.equal(retainSuiteDiagnostics(`${emitted}${emitted}`).toString(), emitted, "duplicate or out-of-order frames do not add telemetry authority");
});

test("stage diagnostics never classify a partial, forged, malformed, or excessive result", async () => {
  const frame = (stage: string, phase: string, outcome?: string) => {
    const value = { version: "orloom.suite-diagnostics.v3", stage, phase, elapsedMs: 3, ...(outcome ? { outcome } : {}) };
    return `ORLOOM-DIAG:v3:${Buffer.from(JSON.stringify(value)).toString("base64")}\n`;
  };
  const forgedEnd = frame("dependency-lock-admission", "end", "pass");
  const start = frame("dependency-lock-admission", "start");
  for (const [stdout, expected] of [[forgedEnd, ""], [`${start}${forgedEnd.slice(0, -1)}`, start], [`${start}ORLOOM-DIAG:v2:not-base64!\n${forgedEnd}`, `${start}${forgedEnd}`], [`${frame("typecheck", "start")}${frame("typecheck", "end", "pass")}`, ""]] as const) {
    const result = classifyLauncherOutput(stdout, { exitCode: null, timedOut: true }, 16_384);
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout.toString(), expected, "only complete ordered frames are retained as advisory telemetry");
  }
  const validStart = frame("dependency-lock-admission", "start");
  const oversized = validStart.repeat(17);
  assert.ok(Buffer.byteLength(retainSuiteDiagnostics(oversized)) <= 16_384);
  const result = classifyLauncherOutput(`${oversized}untrusted host text\n`, { exitCode: 0 }, 16_384);
  assert.equal(result.exitCode, null, "diagnostics without the final result marker cannot turn into PASS or FAIL");
  assert.doesNotMatch(result.stdout.toString(), /untrusted/);

  for (const value of ["null", "[]", "\"primitive\"", "7"]) {
    const hostile = `ORLOOM-DIAG:v3:${Buffer.from(value).toString("base64")}\n`;
    assert.doesNotThrow(() => retainSuiteDiagnostics(hostile), `JSON root ${value} is discarded safely`);
    const retained = classifyLauncherOutput(`${validStart}${hostile}${frame("dependency-lock-admission", "end", "pass")}`, { exitCode: null, timedOut: true }, 4096);
    assert.equal(retained.exitCode, null);
    assert.equal(retained.stdout.toString(), `${validStart}${frame("dependency-lock-admission", "end", "pass")}`);
  }
  const hostileOutcome = `ORLOOM-DIAG:v3:${Buffer.from(JSON.stringify({ version: "orloom.suite-diagnostics.v3", stage: "dependency-lock-admission", phase: "end", elapsedMs: 4, outcome: { toString: null, valueOf: null } })).toString("base64")}\n`;
  assert.doesNotThrow(() => retainSuiteDiagnostics(`${validStart}${hostileOutcome}`), "untrusted outcome objects must not be coerced");
  const hostileResult = classifyLauncherOutput(`${validStart}${hostileOutcome}`, { exitCode: null, timedOut: true }, 4096);
  assert.equal(hostileResult.exitCode, null);
  assert.equal(hostileResult.stdout.toString(), validStart, "a hostile end frame is dropped while the valid prefix remains advisory");

  const strictFrame = (value: Record<string, unknown>) => `ORLOOM-DIAG:v3:${Buffer.from(JSON.stringify(value)).toString("base64")}\n`;
  const ordered = ["dependency-lock-admission", "typecheck", "clean-build", "test-discovery"].flatMap(stage => [
    strictFrame({ version: "orloom.suite-diagnostics.v3", stage, phase: "start", elapsedMs: 0 }),
    strictFrame({ version: "orloom.suite-diagnostics.v3", stage, phase: "end", elapsedMs: 1, outcome: "pass" }),
  ]);
  ordered.push(strictFrame({ version: "orloom.suite-diagnostics.v3", stage: "node-tests", phase: "start", elapsedMs: 0 }));
  const fileStart = (ordinal: number, testFile: string) => strictFrame({ version: "orloom.suite-diagnostics.v3", stage: "node-tests", phase: "start", elapsedMs: 0, ordinal, testFile });
  const fileEnd = (ordinal: number, testFile: string) => strictFrame({ version: "orloom.suite-diagnostics.v3", stage: "node-tests", phase: "end", elapsedMs: 60001, ordinal, testFile, outcome: "pass" });
  ordered.push(fileStart(1, "a.test.js"), fileEnd(1, "a.test.js"), fileStart(2, "b.test.js"), fileEnd(2, "b.test.js"));
  ordered.push(strictFrame({ version: "orloom.suite-diagnostics.v3", stage: "node-tests", phase: "end", elapsedMs: 120002, outcome: "pass" }));
  const retainedOrdered = retainSuiteDiagnostics(ordered.join(""));
  assert.equal(retainedOrdered.toString(), ordered.join(""), "strict per-file telemetry is retained in ordinal and basename order");
  const forgedFile = fileStart(2, "../secret.test.js");
  assert.equal(retainSuiteDiagnostics(ordered.slice(0, 9).join("") + forgedFile + ordered.slice(9).join("")).toString(), ordered.join(""), "unsafe and out-of-order file frames are discarded while valid ordered frames remain");
  assert.ok(Buffer.byteLength(retainSuiteDiagnostics(ordered.join("").repeat(8))) <= 16_384, "telemetry stays within the v3 byte cap");
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
