import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseApprovedWorkerConfiguration, readApprovedTaskManifest, validateApprovedPricing } from "../apps/worker/src/approved-startup.js";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";
import type { RuntimeJournal, RuntimeJournalEntry } from "../apps/worker/src/runtime-journal.js";

const sha = (n: string) => n.repeat(64);
const policyDigest = createHash("sha256").update(JSON.stringify(["node-repo-suite-v1"])).digest("hex");
const manifest = { version: "orloom.approved-worker-task.v1", missionId: "00000000-0000-4000-8000-000000000001", sliceId: "slice-1", repository: "owner/repo", baseSha: "a".repeat(40), planDigest: sha("b"), trustedCheckPolicyDigest: policyDigest, maxBudgetCents: 100, expiresAt: new Date(Date.now() + 60_000).toISOString(), workerImageRef: `sha256:${sha("d")}`, verifierImageRef: `sha256:${sha("e")}` };

test("default and incomplete explicit startup stay disabled without requiring credentials", () => {
  assert.equal(parseApprovedWorkerConfiguration({}).mode, "disabled");
  assert.throws(() => parseApprovedWorkerConfiguration({ ORLOOM_WORKER_MODE: "approved-single" }), /ORLOOM_WORKER_APPROVED_TASK_FILE/);
});

test("manifest reader accepts exact private bounded manifest and rejects unknown or unsafe fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orloom-approved-startup-"));
  try {
    const file = path.join(root, "task.json"); await writeFile(file, JSON.stringify(manifest)); await chmod(file, 0o600);
    assert.deepEqual(await readApprovedTaskManifest(file), manifest);
    await writeFile(file, JSON.stringify({ ...manifest, extra: true })); await chmod(file, 0o600);
    await assert.rejects(readApprovedTaskManifest(file), /unknown fields/);
    await writeFile(file, JSON.stringify({ ...manifest, missionId: "not-a-durable-uuid" })); await chmod(file, 0o600);
    await assert.rejects(readApprovedTaskManifest(file), /fields are invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pricing validation uses cumulative token caps and the same conservative cost and freshness gate", () => {
  const now = Date.now(), pricing = { model: "deepseek-chat", version: "v1", source: "operator snapshot", capturedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), inputCentsPerMillion: 1000, outputCentsPerMillion: 1000, reasoningCentsPerMillion: 1500, safetyMultiplier: 1.2 };
  const cost = validateApprovedPricing(pricing, { maxInputTokens: 10_000, maxOutputTokens: 1_000 }, 100, now);
  assert(cost <= 100);
  assert.throws(() => validateApprovedPricing({ ...pricing, inputCentsPerMillion: 0 }, { maxInputTokens: 10, maxOutputTokens: 10 }, 100, now), /stale or invalid/);
  assert.throws(() => validateApprovedPricing(pricing, { maxInputTokens: 1_000_000, maxOutputTokens: 100_000 }, 1, now), /exceeds the approved task budget/);
  assert.throws(() => validateApprovedPricing({ ...pricing, capturedAt: new Date(now + 1_000).toISOString() }, { maxInputTokens: 10, maxOutputTokens: 10 }, 100, now), /stale or invalid/);
});

test("actual worker entrypoint preserves safe disabled default and rejects partial config without reading secrets", async () => {
  const node = process.execPath, entry = path.resolve("dist/apps/worker/src/main.js");
  const disabled = spawnSync(node, [entry], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(disabled.status, 1); assert.match(disabled.stderr, /independent candidate admission and cancellation reconciliation/);
  const root = await mkdtemp(path.join(os.tmpdir(), "orloom-entrypoint-"));
  try {
    const file = path.join(root, "task.json"); await writeFile(file, JSON.stringify(manifest)); await chmod(file, 0o600);
    const marker = "do-not-print-this-secret";
    const check = spawnSync(node, [entry, "--check-config"], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ORLOOM_WORKER_MODE: "approved-single", ORLOOM_WORKER_APPROVED_TASK_FILE: file, ORLOOM_R2_SECRET_ACCESS_KEY: marker } });
    assert.equal(check.status, 1); assert.match(check.stderr, /ORLOOM_DATABASE_URL/); assert.doesNotMatch(check.stderr, new RegExp(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual check-config validates all nonsecret policy files without opening secret files or connecting", async () => {
  // Private-policy readers reject DrvFS chmod semantics. Use the trusted writable
  // temp mount on Linux; it is outside /work/source and supports real POSIX modes.
  const fixtureParent = process.platform === "linux" ? (process.env.TMPDIR ?? path.dirname(process.cwd())) : path.dirname(process.cwd());
  const root = await mkdtemp(path.join(fixtureParent, "orloom-preflight-proof-"));
  try {
    const runtime = path.join(root, "runtime"); await (await import("node:fs/promises")).mkdir(runtime); await chmod(runtime, 0o700);
    const commands = path.join(root, "checks.json"), pricing = path.join(root, "pricing.json"), task = path.join(root, "task.json"), secret = path.join(root, "secret");
    const now = Date.now();
    const pricingData = { model: "deepseek-chat", version: "snapshot-1", source: "operator fixture", capturedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), inputCentsPerMillion: 1, outputCentsPerMillion: 1, reasoningCentsPerMillion: 1, safetyMultiplier: 1.2 };
    await writeFile(commands, JSON.stringify({ "node-repo-suite-v1": { executable: "node", args: ["scripts/validate.mjs"], timeoutSeconds: 300 } }));
    await writeFile(pricing, JSON.stringify(pricingData)); await writeFile(task, JSON.stringify(manifest)); await writeFile(secret, "unique-secret-sentinel");
    await Promise.all([commands, pricing, task].map(file => chmod(file, 0o600)));
    await chmod(secret, process.platform === "linux" ? 0 : 0o600);
    const lock = path.join(root, "worker.lock"); await writeFile(lock, ""); await chmod(lock, 0o600);
    const repositories = { "owner/repo": { objectStore: path.join(root, "objects.git"), approvedRef: "refs/heads/main" } };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ORLOOM_WORKER_MODE: "approved-single", ORLOOM_WORKER_APPROVED_TASK_FILE: task,
      ORLOOM_DATABASE_URL_FILE: secret, ORLOOM_GITHUB_APP_ID: "1", ORLOOM_GITHUB_PRIVATE_KEY_FILE: secret, ORLOOM_R2_ACCOUNT_ID: "a".repeat(32), ORLOOM_R2_ACCESS_KEY_ID_FILE: secret,
      ORLOOM_R2_SECRET_ACCESS_KEY_FILE: secret, ORLOOM_R2_BUCKET: "orloom-artifacts", ORLOOM_DEEPSEEK_API_KEY_FILE: secret, ORLOOM_GITHUB_INSTALLATION_ID: "1",
      ORLOOM_WORKER_SANDBOX_IMAGE_REF: manifest.workerImageRef, ORLOOM_WORKER_CHECK_COMMANDS_FILE: commands, ORLOOM_WORKER_PRICING_SNAPSHOT_FILE: pricing,
      ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT: runtime, ORLOOM_WORKER_SERVICE_LOCK_FILE: lock, ORLOOM_VERIFIER_IMAGE: manifest.verifierImageRef, ORLOOM_VERIFIER_ID: "verifier-1",
      ORLOOM_VERIFIER_ARTIFACT_ROOT: path.join(root, "artifacts"), ORLOOM_CANDIDATE_ADMISSION_ROOT: path.join(root, "admission"), ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify(repositories),
      ORLOOM_VERIFICATION_POLICY_VERSION: "orloom.node-repo-suite.v9", ORLOOM_VERIFIER_CHECK_ID: "node-repo-suite-v1", ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(["node-repo-suite-v1"]),
      ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON: JSON.stringify(["deepseek"]), ORLOOM_WORKER_ALLOWED_MODELS_JSON: JSON.stringify(["deepseek-chat"]), ORLOOM_WORKER_MAX_PROVIDER_CALLS: "4",
      ORLOOM_WORKER_MAX_INPUT_TOKENS: "10000", ORLOOM_WORKER_MAX_OUTPUT_TOKENS: "10000", ORLOOM_WORKER_MAX_WALL_SECONDS: "60", ORLOOM_WORKER_MAX_TOOL_CALLS: "8",
      ORLOOM_MAX_LANES: "1", ORLOOM_CAPACITY_SLOTS: "1", ORLOOM_CAPACITY_EVIDENCE_VERIFIED: "true", ORLOOM_CAPACITY_EVIDENCE_SHA256: sha("f"),
      ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT: new Date(now + 60_000).toISOString(), ORLOOM_INTEGRATION_ENABLED: "false", ORLOOM_DELIVERY_ENABLED: "false"
    };
    const entry = path.resolve("dist/apps/worker/src/main.js");
    const valid = spawnSync(process.execPath, [entry, "--check-config"], { encoding: "utf8", env });
    assert.equal(valid.status, 0, valid.stderr); assert.match(valid.stdout, /secret contents were not read/); assert.doesNotMatch(valid.stdout + valid.stderr, /unique-secret-sentinel/);
    await writeFile(pricing, JSON.stringify({ ...pricingData, inputCentsPerMillion: 0 })); await chmod(pricing, 0o600);
    const invalid = spawnSync(process.execPath, [entry, "--check-config"], { encoding: "utf8", env });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /pricing snapshot is stale or invalid/); assert.doesNotMatch(invalid.stderr, /unique-secret-sentinel/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retained runtime settlement only replays the approved mission and slice", async () => {
  const entry = (missionId: string, sliceId: string): RuntimeJournalEntry => ({
    version: "orloom.worker-runtime-journal.v1" as RuntimeJournalEntry["version"],
    identity: { missionId, sliceId, leaseEpoch: 1, controllerRunId: "a".repeat(64) }, name: "owned", imageRef: `sha256:${"b".repeat(64)}`,
    labelsDigest: "c".repeat(64), containerId: null, state: "absent", updatedAt: new Date().toISOString(), reconciliation: null, history: []
  });
  const entries = [entry("mission-1", "slice-1"), entry("other-mission", "other-slice")];
  const journal: RuntimeJournal = { async recordIntent() {}, async recordCreated() {}, async recordUnknown() {}, async recordAbsent() {}, async unresolved() { return entries; }, async entries() { return entries; } };
  const settled: string[] = [];
  const store = {
    async registerCancellationRuntimeBinding() {}, async bindCancellationRuntimeContainer() {},
    async reconcileCancellationRuntime(value: RuntimeJournalEntry) { settled.push(value.identity.missionId); return "settled" as const; }
  } as unknown as ConstructorParameters<typeof TrustedRuntimeJournalBridge>[1];
  const bridge = new TrustedRuntimeJournalBridge(journal, store);
  await bridge.reconcileRetained(undefined, { missionId: "mission-1", sliceId: "slice-1" });
  assert.deepEqual(settled, ["mission-1"]);
});
