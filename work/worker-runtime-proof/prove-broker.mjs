import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createControlPlane } from "../../dist/apps/control-plane/src/server.js";
import { MemoryJobStore } from "../../dist/packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../../dist/packages/contracts/src/memory-mission-store.js";
import { DeepSeekHttpClient, executeLease, HttpControlPlane, R2WorkerProgressSink } from "../../dist/packages/agents/src/worker.js";
import { DockerWorkerRuntime } from "../../dist/apps/worker/src/docker-runtime.js";

const proofRoot = process.env.ORLOOM_PROOF_ROOT ?? "/var/lib/orloom/pr2-live-proof-20261013";
const mode = process.env.ORLOOM_PROOF_MODE ?? "fixture";
if (!new Set(["fixture", "live"]).has(mode)) throw new Error("invalid proof mode");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const startedAtUtc = new Date().toISOString();
const runId = `orloom-pr2-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const rootInfo = await (await import("node:fs/promises")).lstat(proofRoot);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || process.platform !== "linux") throw new Error("proof root or host platform is not approved");
const runRoot = await mkdtemp(path.join(proofRoot, `${runId}-`));
await chmod(runRoot, 0o700);
const output = { version: "orloom.pr2.runtime-proof.v1", runId, startedAtUtc, status: "FAIL", mode,
  candidate: { branch: "feat/deepseek-worker-broker", head: process.env.ORLOOM_CANDIDATE_SHA ?? "UNKNOWN" },
  scope: "actual executeLease / HTTP control protocol / DockerWorkerRuntime; isolated local fixture; no integration, push, verification, or PR",
  provider: { kind: mode === "fixture" ? "deterministic test double" : "DeepSeekHttpClient", liveCalls: 0 },
  controls: { terminalResults: [] }, docker: { imageRef: process.env.ORLOOM_SANDBOX_IMAGE_REF ?? "UNKNOWN", protectedBefore: null, protectedAfter: null, containers: [] },
  artifacts: [], limitations: ["GitHub App checkout, R2, production worker bootstrap, production Hostinger A deployment, representative build capacity, and six live lanes are not proven."] };

function command(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 2_000_000, windowsHide: true, ...options });
  if (res.error || res.status !== 0) throw new Error(`fixed command failed: ${path.basename(cmd)} exit=${res.status ?? "spawn"}`);
  return (res.stdout ?? "").trim();
}
function commandAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    const stdout = [], stderr = [];
    child.stdout.on("data", (x) => { if (stdout.reduce((n, b) => n + b.length, 0) < 64_000) stdout.push(x); });
    child.stderr.on("data", (x) => { if (stderr.reduce((n, b) => n + b.length, 0) < 8_000) stderr.push(x); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8").trim()) : reject(new Error(`fixed command failed: ${path.basename(cmd)} exit=${code}`)));
  });
}
function protectedSnapshot() {
  const data = command("/usr/bin/docker", ["inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Status}}", "codex-universal"]);
  const [id, startedAt, restartCount, status] = data.split(" ");
  if (!/^[a-f0-9]{64}$/.test(id ?? "") || !startedAt || !/^\d+$/.test(restartCount ?? "") || status !== "running") throw new Error("protected container baseline unavailable");
  return { id, startedAt, restartCount: Number(restartCount), status };
}
function currentOwned(epoch) {
  const raw = command("/usr/bin/docker", ["ps", "--all", "--no-trunc", "--filter", `label=com.orloom.lease-epoch=${epoch}`, "--format", "{{.ID}} {{.Names}}"]);
  return raw ? raw.split(/\r?\n/).map((line) => { const [id, name] = line.trim().split(/\s+/); return { id, name }; }) : [];
}
function inspectContainer(row, epoch, imageRef) {
  const value = JSON.parse(command("/usr/bin/docker", ["inspect", row.id]))[0];
  const h = value?.HostConfig ?? {}, c = value?.Config ?? {}, labels = c.Labels ?? {};
  const mounts = value?.Mounts ?? [];
  const envNames = (c.Env ?? []).map((entry) => entry.split("=", 1)[0]);
  const evidence = { id: value?.Id, name: value?.Name?.slice(1), runtime: h.Runtime, networkMode: h.NetworkMode, readonlyRootfs: h.ReadonlyRootfs,
    user: c.User, mounts: mounts.map((m) => ({ type: m.Type, destination: m.Destination })), tmpfsPaths: Object.keys(h.Tmpfs ?? {}).sort(),
    capDrop: h.CapDrop, securityOpt: h.SecurityOpt, pidsLimit: h.PidsLimit, memoryBytes: h.Memory, memorySwapBytes: h.MemorySwap, nanoCpus: h.NanoCpus,
    image: c.Image, labels: { owned: labels["com.orloom.worker-owned"], leaseEpoch: labels["com.orloom.lease-epoch"], instance: labels["com.orloom.instance"] }, sensitiveEnvNameCount: envNames.filter((x) => /TOKEN|SECRET|KEY|CREDENTIAL|AUTH|DOCKER/i.test(x)).length };
  if (evidence.runtime !== "runsc" || evidence.networkMode !== "none" || evidence.readonlyRootfs !== true || evidence.user !== "65532:65532" ||
      evidence.mounts.length !== 0 || evidence.tmpfsPaths.join(",") !== "/tmp,/work" ||
      JSON.stringify(evidence.capDrop) !== JSON.stringify(["ALL"]) || !evidence.securityOpt.includes("no-new-privileges:true") || evidence.pidsLimit !== 64 ||
      evidence.memoryBytes !== 268435456 || evidence.memorySwapBytes !== 268435456 || evidence.nanoCpus !== 500000000 || evidence.image !== imageRef ||
      evidence.labels.owned !== "true" || evidence.labels.leaseEpoch !== String(epoch) || evidence.sensitiveEnvNameCount !== 0) throw new Error("runsc enforcement inspection failed");
  return evidence;
}
async function waitForContainer(epoch, imageRef) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const rows = currentOwned(epoch);
    if (rows.length) {
      if (rows.length !== 1 || !rows[0].name.startsWith(`orloom-worker-${epoch}-`)) throw new Error("unexpected lease-labeled container set");
      const row = { ...rows[0], ...inspectContainer(rows[0], epoch, imageRef) };
      output.docker.containers.push(row);
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("expected isolated sandbox was not inspectable");
}
async function evidenceStore(directory) {
  const evidenceDir = path.join(directory, "evidence");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  return {
    async put(bytes) {
      const digest = sha256(bytes), key = `sha256/${digest}`, file = path.join(evidenceDir, digest);
      try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      return { key, sha256: digest };
    },
    async get(key) {
      if (!/^sha256\/[a-f0-9]{64}$/.test(key)) throw new Error("invalid content key");
      return await readFile(path.join(evidenceDir, key.slice(7)));
    },
    directory: evidenceDir
  };
}

let server;
let lease;
let bareRepo;
let store;
let runtime;
let controls = null;
let usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
let providerCallMayHaveBeenSent = false;
let providerOutcomeUnknown = false;
let ledgerReserved = false;
let ledgerSettled = false;
let provider;
const modelIds = [];
const imageRef = output.docker.imageRef;
let epoch = 0;
try {
  output.docker.protectedBefore = protectedSnapshot();
  if (!imageRef || !/^sha256:[a-f0-9]{64}$/.test(imageRef)) throw new Error("immutable local sandbox image ID is required");
  const tag = command("/usr/bin/docker", ["image", "inspect", "--format", "{{.Id}}", imageRef]);
  if (tag !== imageRef) throw new Error("sandbox image identity mismatch");

  bareRepo = path.join(runRoot, "source.git");
  const workRepo = path.join(runRoot, "source-work");
  await mkdir(workRepo, { mode: 0o700 });
  command("/usr/bin/git", ["init", "--bare", "--quiet", bareRepo]);
  command("/usr/bin/git", ["init", "--quiet", workRepo]);
  command("/usr/bin/git", ["-C", workRepo, "config", "user.name", "Orloom Proof Fixture"]);
  command("/usr/bin/git", ["-C", workRepo, "config", "user.email", "proof@orloom.invalid"]);
  await mkdir(path.join(workRepo, "src"));
  await writeFile(path.join(workRepo, "src", "status.txt"), "hold\n", { mode: 0o600 });
  command("/usr/bin/git", ["-C", workRepo, "add", "--", "src/status.txt"]);
  command("/usr/bin/git", ["-C", workRepo, "commit", "--quiet", "--no-gpg-sign", "-m", "proof base"]);
  const baseSha = command("/usr/bin/git", ["-C", workRepo, "rev-parse", "HEAD"]);
  command("/usr/bin/git", ["-C", workRepo, "remote", "add", "origin", bareRepo]);
  command("/usr/bin/git", ["-C", workRepo, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  const policy = ["check:unit", "check:delay"];
  const policyDigest = sha256(Buffer.from(JSON.stringify(policy)));
  const ownerToken = randomUUID(), bootstrapToken = randomUUID();
  store = new MemoryMissionStore();
  await store.configureCapacity(1, "a".repeat(64), new Date(Date.now() + 120_000).toISOString());
  server = createControlPlane({ mode: "local", port: 0, sessionToken: ownerToken, workerToken: bootstrapToken, capacitySlots: 1, maxLanes: 6,
    trustedCheckPolicy: policy, trustedCheckPolicyDigest: policyDigest, workerMaxProviderCalls: 6, workerMaxInputTokens: 12_000, workerMaxOutputTokens: 1_024,
    workerMaxWallSeconds: 180, workerAllowedProviders: ["deepseek"], workerAllowedModels: ["deepseek-flash"] }, new MemoryJobStore(), store);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local control API did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${baseUrl}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) });
  if (!login.ok) throw new Error("local owner login failed");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("local owner session unavailable");
  const missionResponse = await fetch(`${baseUrl}/api/missions`, { method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ repository: "fixture/pr2-runtime", baseSha, objective: "Change src/status.txt from hold to ready using the allowed tools.", acceptance: ["src/status.txt is exactly ready followed by newline"], budgetCents: 1 }) });
  if (missionResponse.status !== 201) throw new Error("local mission create failed");
  const mission = await missionResponse.json();
  const planResponse = await fetch(`${baseUrl}/api/missions/${mission.id}/plan`, { method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ slices: [{ id: "slice-runtime", objective: "Apply and check the bounded fixture change", dependencies: [], owner: "builder", scopes: ["src/status.txt"], checks: ["check:unit", "check:delay"], budgetCents: 1 }] }) });
  if (planResponse.status !== 201) throw new Error("local plan creation failed");
  if (!(await fetch(`${baseUrl}/api/missions/${mission.id}/approve`, { method: "POST", headers: { cookie } })).ok) throw new Error("local mission approval failed");
  const control = new HttpControlPlane(baseUrl, bootstrapToken);
  const submitResult = control.result.bind(control);
  control.result = async (resultLease, result) => {
    const record = { outcome: "candidateSha" in result ? "CANDIDATE" : result.outcome, evidenceRefCount: result.evidenceRefs?.length ?? 0,
      candidateSha: "candidateSha" in result ? result.candidateSha : undefined, acknowledged: "PENDING" };
    output.controls.terminalResults.push(record);
    try { await submitResult(resultLease, result); record.acknowledged = "PASS"; }
    catch (error) { record.acknowledged = "FAIL"; record.errorClass = error?.name ?? "Error"; throw error; }
  };
  lease = await control.claim();
  if (!lease || lease.mission.baseSha !== baseSha || lease.executionLimits.reservedBudgetCents !== 1) throw new Error("actual local HTTP lease claim failed identity/budget checks");
  epoch = lease.leaseEpoch;
  controls = { baseUrl, cookie, missionId: mission.id, sliceId: lease.slice.id };
  output.controls = { claim: "PASS", terminalResults: [], leaseEpoch: lease.leaseEpoch, capacitySlot: lease.capacitySlot, baseSha,
    policyDigest: lease.trustedCheckPolicyDigest, missionId: lease.mission.id, sliceId: lease.slice.id, result: "PENDING" };

  const imageId = imageRef;
  const checkCommands = {
    "check:unit": { executable: "node", args: ["-e", "const fs=require('node:fs');if(fs.readFileSync('src/status.txt','utf8')!=='ready\\n')process.exit(9);process.stdout.write('status-ok')"], timeoutSeconds: 5 },
    "check:delay": { executable: "node", args: ["-e", "setTimeout(()=>process.stdout.write('late'),5000)"], timeoutSeconds: 8 }
  };
  const checkoutTransport = { async fetchExact({ fetch }) { await fetch(bareRepo); } };
  const checkoutTokens = { async createCheckoutToken() { throw new Error("fixture runtime unexpectedly requested GitHub credentials"); } };
  runtime = new DockerWorkerRuntime({ imageRef: imageId, installationId: 1, checkoutTokens, checkoutTransport, checks: checkCommands, scratchRoot: path.join(runRoot, "scratch"), dockerPath: "/usr/bin/docker" });
  const evidence = await evidenceStore(runRoot);
  const progress = new R2WorkerProgressSink(evidence);
  const progressSummary = [];
  const progressSink = { async append(progressLease, event) {
    progressSummary.push({ ordinal: event.ordinal, phase: event.phase, status: event.status, providerCalls: event.providerCalls,
      inputTokens: event.inputTokens, outputTokens: event.outputTokens });
    return await progress.append(progressLease, event);
  } };
  provider = mode === "fixture"
    ? {
        async listModels() { return ["deepseek-flash"]; },
        async probeTools(model) { await waitForContainer(epoch, imageId); return { model, inputTokens: 2, outputTokens: 1 }; },
        async complete(model, messages) {
          const step = messages.filter((x) => x.role === "assistant" && x.tool_calls?.length).length;
          const tool = (name, args, id) => ({ model, inputTokens: 6, outputTokens: 5, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } });
          if (step === 0) return tool("read_file", { path: "src/status.txt" }, "fixture-read");
          if (step === 1) return tool("apply_patch", { path: "src/status.txt", oldText: "hold", newText: "ready" }, "fixture-patch");
          if (step === 2) return tool("run_check", { checkId: "check:unit" }, "fixture-check");
          return { model, inputTokens: 6, outputTokens: 5, message: { role: "assistant", content: "The requested change and check completed." } };
        }
      }
    : await (async () => {
        const secretPath = process.env.ORLOOM_DEEPSEEK_API_KEY_FILE ?? "/run/orloom/pr2-deepseek-api-key";
        const { lstat } = await import("node:fs/promises");
        const st = await lstat(secretPath);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o077) !== 0 || st.size < 16 || st.size > 4096) throw new Error("live provider credential file missing or unsafe");
        const key = (await readFile(secretPath, "utf8")).trim();
        if (!key || /[\r\n\0]/.test(key)) throw new Error("live provider credential file malformed");
        const client = new DeepSeekHttpClient(key);
        const ledgerPath = "/var/lib/orloom/provider-spend-ledger.json";
        const reservationId = runId;
        async function mutateLedger(mutator) {
          const lockPath = `${ledgerPath}.lock`;
          await mkdir(lockPath, { mode: 0o700 });
          try {
            const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
            if (ledger.version !== "orloom.provider-spend-ledger.v1" || ledger.aggregateCap !== 5) throw new Error("shared spend ledger invalid");
            await mutator(ledger);
            ledger.updatedAtUtc = new Date().toISOString();
            const temp = `${ledgerPath}.${randomUUID()}.tmp`;
            await writeFile(temp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600, flag: "wx" });
            await rename(temp, ledgerPath);
          } finally { await rm(lockPath, { recursive: true, force: true }); }
        }
        async function reserve() {
          if (ledgerReserved) return;
          await mutateLedger((ledger) => {
            const reservedCents = 1;
            const usedCents = Math.round((ledger.confirmedSpend + ledger.reservedSpend) * 100);
            if (usedCents + reservedCents > Math.round(ledger.aggregateCap * 100)) throw new Error("aggregate DeepSeek cap exhausted");
            ledger.reservedSpend = Number((ledger.reservedSpend + 0.01).toFixed(2));
            ledger.remainingUnreserved = Number((ledger.aggregateCap - ledger.confirmedSpend - ledger.reservedSpend).toFixed(2));
            ledger.status = "RESERVED";
            ledger.requests.push({ id: reservationId, status: "RESERVED", reservedUsd: 0.01, maxModel: "deepseek-flash", maxInputTokens: 12_000, maxOutputTokens: 1_024, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", startedAtUtc: new Date().toISOString() });
          });
          ledgerReserved = true;
        }
        return {
          async listModels(signal) { const models = await client.listModels(signal); modelIds.push(models.includes("deepseek-flash") ? "deepseek-flash-listed" : "deepseek-flash-not-listed"); return models; },
          async probeTools(model, signal) { await waitForContainer(epoch, imageId); await reserve(); providerCallMayHaveBeenSent = true; usage.calls++; try { const result = await client.probeTools(model, signal); modelIds.push(result.model); usage.inputTokens += result.inputTokens; usage.outputTokens += result.outputTokens; return result; } catch (error) { providerOutcomeUnknown = true; throw error; } },
          async complete(model, messages, signal, maxOutputTokens) { await reserve(); providerCallMayHaveBeenSent = true; usage.calls++; try { const result = await client.complete(model, messages, signal, maxOutputTokens); modelIds.push(result.model); usage.inputTokens += result.inputTokens; usage.outputTokens += result.outputTokens; return result; } catch (error) { providerOutcomeUnknown = true; throw error; } },
          async finishLedger(uncertain) {
            if (!ledgerReserved || ledgerSettled) return;
            await mutateLedger((ledger) => {
              const row = ledger.requests.find((entry) => entry.id === reservationId);
              if (!row || row.status !== "RESERVED") throw new Error("shared spend reservation cannot be reconciled safely");
              if (uncertain) { row.status = "UNKNOWN"; row.reason = "provider request outcome or usage may be uncertain; reservation retained"; }
              else {
                const priceCentsPerMillion = { input: 30, output: 120 };
                const upperBoundUsd = (usage.inputTokens * priceCentsPerMillion.input + usage.outputTokens * priceCentsPerMillion.output) / 100_000_000 * 1.5;
                if (upperBoundUsd > 0.01) throw new Error("observed provider cost exceeded the one-cent reservation; retain reservation and stop");
                const settled = Number(upperBoundUsd.toFixed(8));
                ledger.reservedSpend = Number((ledger.reservedSpend - 0.01).toFixed(2));
                ledger.confirmedSpend = Number((ledger.confirmedSpend + settled).toFixed(8));
                ledger.remainingUnreserved = Number((ledger.aggregateCap - ledger.confirmedSpend - ledger.reservedSpend).toFixed(8));
                row.status = "SETTLED"; row.confirmedUpperBoundUsd = settled; row.inputTokens = usage.inputTokens; row.outputTokens = usage.outputTokens; row.calls = usage.calls; row.settledAtUtc = new Date().toISOString();
                ledger.status = "SETTLED";
              }
              if (uncertain) ledger.status = "UNKNOWN_RESERVATION_RETAINED";
            });
            ledgerSettled = true;
          }
        };
      })();
  const options = { allowedModels: ["deepseek-flash"], allowedProviders: ["deepseek"], trustedChecks: policy, trustedCheckPolicyDigest: policyDigest,
    trustedCheckCommands: checkCommands, sandboxImageRef: imageId, maxToolCalls: 4,
    pricing: { model: "deepseek-flash", version: "DeepSeek pricing snapshot peak-rate ceiling 2026-10-13", source: "https://api-docs.deepseek.com/quick_start/pricing/; peak input cache-miss $0.30/M, output/reasoning $1.20/M", capturedAt: startedAtUtc, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), inputCentsPerMillion: 30, outputCentsPerMillion: 120, reasoningCentsPerMillion: 120, safetyMultiplier: 1.5 } };
  const checkIds = { "check:unit": ["check:unit"], "check:delay": ["check:delay"] };
  await executeLease(lease, { control, provider, runtime, evidence, progress: progressSink, checks: checkIds, options });
  output.controls.progressSummary = progressSummary;
  const stateResponse = await fetch(`${baseUrl}/api/missions/${mission.id}`, { headers: { cookie } });
  if (!stateResponse.ok) throw new Error("local mission state unavailable");
  const state = await stateResponse.json();
  const slice = state.slices.find((row) => row.id === lease.slice.id);
  if (!slice) throw new Error("claimed slice missing from mission state");
  output.controls.result = slice.status;
  output.controls.candidateSha = slice.candidateSha ?? null;
  output.controls.resultEvidenceRefs = slice.evidenceRefs ?? [];
  if (slice.status !== "awaiting_verification" || !/^[a-f0-9]{40}$/.test(slice.candidateSha ?? "")) throw new Error(`broker candidate handoff did not reach awaiting_verification (${slice.status})`);

  const indexRef = slice.evidenceRefs.find((x) => x.startsWith("evidence-index:sha256/"));
  if (!indexRef) throw new Error("candidate evidence index is missing");
  const indexKey = indexRef.slice(indexRef.indexOf(":") + 1);
  const indexBytes = await evidence.get(indexKey);
  const index = JSON.parse(indexBytes.toString("utf8"));
  const bundleRef = index.entries.find((x) => x.name === "candidate-bundle")?.reference;
  if (!bundleRef) throw new Error("verified candidate bundle is missing");
  const bundleKey = bundleRef.slice(bundleRef.indexOf(":") + 1);
  const bundle = await evidence.get(bundleKey);
  const bundlePath = path.join(runRoot, "candidate.bundle");
  await writeFile(bundlePath, bundle, { mode: 0o600 });
  const importedRepo = path.join(runRoot, "bundle-import.git");
  command("/usr/bin/git", ["init", "--bare", "--quiet", importedRepo]);
  command("/usr/bin/git", ["--git-dir", importedRepo, "fetch", "--quiet", bareRepo, baseSha]);
  command("/usr/bin/git", ["--git-dir", importedRepo, "fetch", "--quiet", bundlePath, "refs/heads/orloom-candidate:refs/heads/candidate"]);
  const importedSha = command("/usr/bin/git", ["--git-dir", importedRepo, "rev-parse", "refs/heads/candidate"]);
  const importedText = command("/usr/bin/git", ["--git-dir", importedRepo, "show", `${importedSha}:src/status.txt`]);
  if (importedSha !== slice.candidateSha || importedText !== "ready") throw new Error("candidate bundle import did not preserve exact candidate bytes");
  for (const row of index.entries) {
    const reference = row.reference ?? "";
    const contentMarker = reference.lastIndexOf(":sha256/");
    const key = row.name === "progress" ? reference.split(":", 1)[0] : contentMarker >= 0 ? reference.slice(contentMarker + 1) : "";
    if (!/^sha256\/[a-f0-9]{64}$/.test(key)) throw new Error("evidence index contains an invalid reference");
    const bytes = await evidence.get(key);
    if (sha256(bytes) !== row.sha256 || key !== "sha256/" + row.sha256) throw new Error("content-addressed evidence digest failed readback");
    output.artifacts.push({ name: row.name, key, sha256: row.sha256, bytes: bytes.length });
  }
  output.docker.cleanupAfterCandidate = currentOwned(epoch);
  if (output.docker.cleanupAfterCandidate.length !== 0) throw new Error("broker workspace left an owned container behind");

  const cancellation = await runtime.create(lease);
  await cancellation.checkout(lease.mission.repository, lease.mission.baseSha);
  const cancelRow = await waitForContainer(epoch, imageId);
  output.docker.cancellationContainer = cancelRow;
  let cancelled = false;
  try { await cancellation.runCheck("check:delay", AbortSignal.timeout(300)); }
  catch { cancelled = true; }
  await cancellation.close();
  output.docker.cancellation = { interruptedRpcRejected: cancelled, exactOwnedContainerAbsent: currentOwned(epoch).every((row) => row.id !== cancelRow.id) };
  if (!cancelled || !output.docker.cancellation.exactOwnedContainerAbsent) throw new Error("actual Docker RPC cancellation/cleanup proof failed");

  if (mode === "live") {
    await provider.finishLedger(providerOutcomeUnknown);
    output.provider = { kind: "DeepSeekHttpClient", liveCalls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      modelIdentities: modelIds, spendLedger: providerOutcomeUnknown ? "UNKNOWN_RESERVATION_RETAINED" : "SETTLED_AT_CONSERVATIVE_PEAK_RATE" };
  }
  output.docker.protectedAfter = protectedSnapshot();
  if (JSON.stringify(output.docker.protectedBefore) !== JSON.stringify(output.docker.protectedAfter)) throw new Error("protected codex-universal container changed during proof");
  output.status = "PASS";
} catch (error) {
  output.status = "FAIL";
  output.failureType = error?.name ?? "Error";
  output.providerFailureMayBeUnknown = providerCallMayHaveBeenSent && !ledgerSettled;
  if (mode === "live" && ledgerReserved && provider?.finishLedger) {
    try { await provider.finishLedger(providerOutcomeUnknown); } catch { output.spendLedger = "UNKNOWN: reservation could not be reconciled; do not retry"; }
  }
} finally {
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (output.docker.protectedBefore && !output.docker.protectedAfter) {
    try { output.docker.protectedAfter = protectedSnapshot(); } catch { output.docker.protectedAfter = "UNKNOWN"; }
  }
  output.finishedAtUtc = new Date().toISOString();
  output.durationMs = Date.parse(output.finishedAtUtc) - Date.parse(startedAtUtc);
  output.usage = { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  output.result = output.status === "PASS" ? "awaiting_verification" : "UNKNOWN";
  const evidenceFile = path.join(runRoot, "runtime-proof.json");
  await writeFile(evidenceFile, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: output.status, runId, result: output.result, durationMs: output.durationMs, evidenceFile,
    provider: output.provider, controls: { claim: output.controls?.claim, result: output.controls?.result },
    docker: { imageRef: output.docker.imageRef, containerCount: output.docker.containers.length, cancellation: output.docker.cancellation,
      cleanupAfterCandidate: output.docker.cleanupAfterCandidate, protectedUnchanged: JSON.stringify(output.docker.protectedBefore) === JSON.stringify(output.docker.protectedAfter) },
    failureType: output.failureType }) + "\n");
  if (output.status !== "PASS") process.exitCode = 1;
}
