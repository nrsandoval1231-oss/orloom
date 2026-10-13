import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { createCgroupObserver } from "./cgroup-observer.mjs";

const exec = promisify(execFile);
const ROOT = "/var/lib/orloom/c3-jobs-probe-20261013";
const INCOMING = ROOT + ".incoming";
const CANDIDATE = "890209224cd042f5367085ffdf5591b3aa92d739";
const MANIFEST = "cd6a3329d33c154619a194982bb5a312115e43020dc6e65964bf177336cac86b";
const LABEL = "ORL-C3-JOBS-PROBE";
const PROTECTED = "5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running";
const sha = value => createHash("sha256").update(value).digest("hex");
const docker = args => exec("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/root" } }).then(value => value.stdout.trim());
const git = args => exec("git", args, { env: { PATH: "/usr/bin:/bin", HOME: "/root", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
const valid = (value, expression, message) => assert.match(value, expression, message);

if (process.getuid?.() !== 0) throw new Error("host root is required");
if (process.argv.length !== 2) throw new Error("usage: jobs-probe.mjs");
const regular = async file => { const s = await lstat(file); assert.ok(s.isFile() && !s.isSymbolicLink(), file + " must be a regular file"); };
await Promise.all([regular(INCOMING + "/candidate.bundle"), regular(INCOMING + "/candidate-identity.json"), regular(INCOMING + "/probe-bindings.json")]);
const bind = JSON.parse(await readFile(INCOMING + "/probe-bindings.json", "utf8"));
assert.deepEqual(Object.keys(bind).sort(), ["baseSha", "candidateSha", "image", "imageDigest", "sourceManifestSha256", "sourceRef"]);
assert.equal(bind.candidateSha, CANDIDATE); assert.equal(bind.sourceManifestSha256, MANIFEST);
valid(bind.baseSha, /^[a-f0-9]{40}$/, "invalid base"); valid(bind.imageDigest, /^[a-f0-9]{64}$/, "invalid image digest");
assert.ok(bind.image === "sha256:" + bind.imageDigest || bind.image.endsWith("@sha256:" + bind.imageDigest), "image must be digest bound");
const identity = JSON.parse(await readFile(INCOMING + "/candidate-identity.json", "utf8"));
assert.equal(identity.candidateSha, CANDIDATE); assert.equal(identity.sourceRef, bind.sourceRef); assert.equal(identity.suiteManifestSha256, MANIFEST);
assert.equal(identity.bundleSha256, sha(await readFile(INCOMING + "/candidate.bundle")));
assert.ok(!await lstat(ROOT).then(() => true, () => false), "one-shot root already exists");
await mkdir(ROOT, { mode: 0o700 }); await mkdir(ROOT + "/evidence", { mode: 0o700 }); await mkdir(ROOT + "/input", { mode: 0o700 });
await git(["clone", "--bare", "--no-local", INCOMING + "/candidate.bundle", ROOT + "/source.git"]);
const gitDir = ["--git-dir=" + ROOT + "/source.git"];
assert.equal((await git([...gitDir, "rev-parse", bind.sourceRef + "^{commit}"])).stdout.trim(), CANDIDATE);
assert.equal((await git([...gitDir, "rev-parse", "--is-bare-repository"])).stdout.trim(), "true");
await git(["clone", "--no-checkout", ROOT + "/source.git", ROOT + "/input/source"]);
await git(["-C", ROOT + "/input/source", "checkout", "--detach", CANDIDATE]);
assert.equal((await git(["-C", ROOT + "/input/source", "status", "--porcelain=v1"])).stdout, "");
assert.equal(sha(await readFile(ROOT + "/input/source/.agent/ORL-C3-SUITE-MANIFEST.sha256")), MANIFEST);
for (const row of (await readFile(ROOT + "/input/source/.agent/ORL-C3-SUITE-MANIFEST.sha256", "utf8")).trim().split("\n")) {
  const match = /^([a-f0-9]{64})  ([^/].*)$/.exec(row); assert.ok(match, "invalid source manifest row");
  const relative = match[2]; assert.ok(!relative.includes(".."), "unsafe manifest path");
  assert.equal(sha(await readFile(ROOT + "/input/source/" + relative)), match[1], "manifest mismatch: " + relative);
}
await cp(new URL("./jobs-probe-entry.mjs", import.meta.url), ROOT + "/input/jobs-probe-entry.mjs", { mode: 0o400 });
await cp(new URL("./cgroup-observer.mjs", import.meta.url), ROOT + "/cgroup-observer.mjs", { mode: 0o400 });
await writeFile(ROOT + "/one-shot.json", JSON.stringify({ format: "orloom.c3.jobs-probe.v1", diagnosticOnly: true, certificate: null, candidateSha: CANDIDATE, startedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o400 });

assert.equal(await docker(["inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}", "codex-universal"]), PROTECTED);
assert.equal(await docker(["image", "inspect", "--format", "{{.Id}}|{{index .Config.Labels \"orloom.packet\"}}|{{index .Config.Labels \"orloom.candidate\"}}", bind.image]), "sha256:" + bind.imageDigest + "|ORL-C3|" + CANDIDATE);
const runId = "orloom-jobs-probe-" + randomUUID();
const eventSince = new Date().toISOString();
const config = await exec("mktemp", ["-d", "/run/orloom-c3-jobs-probe.XXXXXX"], { env: { PATH: "/usr/bin:/bin", HOME: "/root" } }).then(value => value.stdout.trim());
await chmod(config, 0o700);
const dc = args => exec("/usr/bin/docker", ["--config", config, "--host", "unix:///var/run/docker.sock", ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/root" } }).then(value => value.stdout.trim());
const state = ROOT + "/launcher-state";
let cid = "";
const started = Date.now(), rows = [];
const observer = createCgroupObserver({ readFile });
let binding = null, done = false, output = Buffer.alloc(0), error = Buffer.alloc(0), exitCode = null, truncated = false, cleanupUncertain = false;
try {
  await writeFile(state, "ORL-C3-JOBS-PROBE|" + runId + "|" + bind.image + "||creating\n", { flag: "wx", mode: 0o600 });
  cid = await dc(["create", "--interactive", "--pull=never", "--name", runId, "--label=orloom.packet=" + LABEL, "--label=orloom.run=" + runId, "--runtime=runsc", "--network=none", "--read-only", "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=128", "--memory=1g", "--memory-swap=1g", "--cpus=1", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700", "--tmpfs=/work:rw,exec,nosuid,nodev,size=512m,uid=65532,gid=65532,mode=0700", "--entrypoint=/bin/sh", bind.image, "-ec", "tar -xf - -C /work && cd /work/source && exec /usr/local/bin/node /work/jobs-probe-entry.mjs"]);
  valid(cid, /^[a-f0-9]{64}$/, "invalid CID");
  const inspect = JSON.parse(await dc(["inspect", "--format", "{{json .}}", cid]));
  assert.equal(inspect.Config.Labels["orloom.packet"], LABEL); assert.equal(inspect.Config.Labels["orloom.run"], runId);
  assert.equal(inspect.Config.Labels["orloom.candidate"], CANDIDATE); assert.equal(inspect.Config.Image, bind.image);
  assert.equal(inspect.HostConfig.Runtime, "runsc"); assert.equal(inspect.HostConfig.Memory, 1073741824); assert.equal(inspect.HostConfig.MemorySwap, 1073741824);
  assert.equal(inspect.HostConfig.PidsLimit, 128); assert.equal(inspect.HostConfig.NanoCpus, 1000000000); assert.equal(inspect.HostConfig.NetworkMode, "none");
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true); assert.equal(inspect.Config.User, "65532:65532"); assert.deepEqual(inspect.Mounts, []);
  assert.ok(inspect.HostConfig.Tmpfs["/tmp"].includes("size=16m") && inspect.HostConfig.Tmpfs["/work"].includes("size=512m"), "tmpfs profile differs");
  await writeFile(state, "ORL-C3-JOBS-PROBE|" + runId + "|" + bind.image + "|" + cid + "|running\n", { mode: 0o600 });
  const tar = spawn("tar", ["-C", ROOT + "/input", "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
  const start = spawn("/usr/bin/timeout", ["--signal=TERM", "--kill-after=2s", "210s", "/usr/bin/docker", "--config", config, "--host", "unix:///var/run/docker.sock", "start", "--attach", "--interactive", cid], { env: { PATH: "/usr/bin:/bin", HOME: "/root" }, stdio: ["pipe", "pipe", "pipe"] });
  tar.stdout.pipe(start.stdin);
  const capture = (target, value) => { if (target.length + value.length > 65536) { truncated = true; return Buffer.concat([target, value]).subarray(0, 65536); } return Buffer.concat([target, value]); };
  start.stdout.on("data", value => { output = capture(output, value); }); start.stderr.on("data", value => { error = capture(error, value); });
  const sampling = (async () => { while (!done && rows.length < 960 && Date.now() - started <= 240000) { try { const info = JSON.parse(await dc(["inspect", "--format", "{{json .}}", cid])); if (!binding) { const cgroup = await observer.exactCgroup(cid, info.State.Pid); if (cgroup) binding = cgroup; } if (binding) rows.push(await observer.sample(binding, Date.now() - started)); } catch {} await new Promise(resolve => setTimeout(resolve, 250)); } })();
  exitCode = await new Promise(resolve => start.once("exit", code => resolve(code)));
  done = true; await sampling;
} finally {
  done = true;
  if (cid) {
    let actual = "";
    try { actual = await dc(["inspect", "--format", "{{.Id}}|{{index .Config.Labels \"orloom.packet\"}}|{{index .Config.Labels \"orloom.run\"}}|{{.Config.Image}}", cid]); } catch { cleanupUncertain = true; }
    if (actual === cid + "|" + LABEL + "|" + runId + "|" + bind.image) {
      try { await dc(["rm", "--force", cid]); } catch { cleanupUncertain = true; }
    } else if (actual) cleanupUncertain = true;
  }
  if (cleanupUncertain) await writeFile(state, "ORL-C3-JOBS-PROBE|" + runId + "|" + bind.image + "|" + cid + "|quarantined\n", { mode: 0o600 });
  else await rm(state);
}
const last = rows.at(-1)?.memoryEvents ?? {};
const text = output.toString("utf8");
const behaviours = ["lifecycle fences stale completion and preserves UNKNOWN after interrupted execution", "migration constrains status and lease consistency"];
const passed = exitCode === 0 && !truncated && !cleanupUncertain && behaviours.every(name => new RegExp("# Subtest: " + name.replace(/[.*+?^$()|[\]\\]/g, "\\$&") + "\\r?\\n.*?# pass 1", "s").test(text)) && last.max === 0 && last.oom === 0 && last.oom_kill === 0;
const evidence = ROOT + "/evidence/" + runId;
await mkdir(evidence, { mode: 0o700 });
await writeFile(evidence + "/stdout.txt", output, { mode: 0o400 });
await writeFile(evidence + "/stderr.txt", error, { mode: 0o400 });
await writeFile(evidence + "/cgroup.jsonl", rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o400 });
const events = cid ? await dc(["events", "--since", eventSince, "--until", new Date().toISOString(), "--filter", "type=container", "--filter", "container=" + cid, "--format", "{{json .}}"]).catch(() => "") : "";
await writeFile(evidence + "/exact-sandbox-events.jsonl", events + (events ? "\n" : ""), { mode: 0o400 });
await writeFile(evidence + "/result.json", JSON.stringify({ format: "orloom.c3.jobs-probe.result.v1", diagnosticOnly: true, certificate: null, candidateSha: CANDIDATE, imageDigest: bind.imageDigest, sandboxId: runId, containerId: cid || null, exitCode, truncated, cleanupUncertain, requiredBehaviours: behaviours, observedSamples: rows.length, finalMemoryEvents: last, outcome: passed ? "diagnostic-pass" : "diagnostic-unknown-or-fail" }, null, 2) + "\n", { mode: 0o400 });
await rm(config, { recursive: true, force: true });
assert.equal(await docker(["inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}", "codex-universal"]), PROTECTED);
if (!passed) process.exitCode = 1;
