import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { assertRoleConfig, loadConfig, validateRoleConfig } from "../packages/config/src/config.js";
import { createCodexAdapter, createGitHubAppAdapter, createR2ArtifactStore, LocalArtifactStore, verifyWebhookSignature } from "../packages/adapters/src/providers.js";
import { createCodexSdkAdapter } from "../packages/adapters/src/codex-sdk.js";

test("configuration validates roles and does not reveal configured values in errors", () => {
  assert.equal(loadConfig({ ORLOOM_MODE: "local", PORT: "3210" }).port, 3210);
  const safeDefaults=loadConfig({ORLOOM_MODE:"local"});assert.equal(safeDefaults.capacitySlots,0);assert.deepEqual(safeDefaults.workerAllowedModels,[]);assert.equal(safeDefaults.trustedCheckPolicyDigest,null);
  assert.throws(()=>loadConfig({ORLOOM_MODE:"local",ORLOOM_CAPACITY_SLOTS:"1"}),/verified, unexpired isolation evidence binding/);
  assert.throws(() => loadConfig({ ORLOOM_MODE: "cloud", ORLOOM_DATABASE_URL: "" }), /requires ORLOOM_DATABASE_URL/);
  assert.throws(() => loadConfig({ ORLOOM_MODE: "production-secret" }), /ORLOOM_MODE must be local or cloud/);
  const github = validateRoleConfig("github", { ORLOOM_GITHUB_APP_ID: "not-a-number-secret", ORLOOM_GITHUB_PRIVATE_KEY: "private-value", ORLOOM_GITHUB_WEBHOOK_SECRET: "hook-value" });
  assert.deepEqual(github.missingFields, ["ORLOOM_GITHUB_APP_ID"]);
  assert.throws(() => assertRoleConfig("artifact", { ORLOOM_R2_ACCOUNT_ID: "private-account-secret" }), error => {
    assert.match((error as Error).message, /ORLOOM_R2_ACCESS_KEY_ID/);
    assert.doesNotMatch((error as Error).message, /private-account-secret/);
    return true;
  });
  assert.equal(validateRoleConfig("worker", { ORLOOM_WORKER_CONTROL_URL: "https://worker.example", ORLOOM_WORKER_TOKEN: "x", ORLOOM_WORKER_JOB_DIRECTORY: "C:/isolated/jobs", CODEX_HOME: "C:/isolated/codex" }).ok, true);
  assert.deepEqual(validateRoleConfig("worker", {}).missingFields, ["ORLOOM_WORKER_CONTROL_URL", "ORLOOM_WORKER_TOKEN", "ORLOOM_WORKER_JOB_DIRECTORY", "CODEX_HOME"]);
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs", CODEX_HOME: "relative/codex" }).missingFields.includes("CODEX_HOME"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "C:\\runner\\jobs", CODEX_HOME: "C:\\runner\\jobs\\.codex" }).missingFields.includes("CODEX_HOME"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs", CODEX_HOME: "/srv/codex", CODEX_API_KEY: "should-not-be-used" }).missingFields.includes("CODEX_API_KEY"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs", CODEX_HOME: "/srv/codex", OPENAI_API_KEY: "private-value" }).missingFields.includes("OPENAI_API_KEY"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs", CODEX_HOME: "/" }).missingFields.includes("CODEX_HOME"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs", CODEX_HOME: "/srv/jobs/.codex" }).missingFields.includes("CODEX_HOME"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs", CODEX_HOME: "/srv/jobs/../jobs/.codex" }).missingFields.includes("CODEX_HOME"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "/srv", CODEX_HOME: "/srv/..cache" }).missingFields.includes("CODEX_HOME"));
  assert(validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "C:\\runner\\jobs", CODEX_HOME: "/srv/codex" }).missingFields.includes("CODEX_HOME"));
  assert(!validateRoleConfig("worker", { ORLOOM_WORKER_JOB_DIRECTORY: "C:\\runner\\jobs", CODEX_HOME: "C:\\runner\\codex" }).missingFields.includes("CODEX_HOME"));
});

test("webhook signature is constant-time compared after strict digest length check", () => {
  const body = Buffer.from("payload");
  const signature = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(body, signature, "hook-secret"), true);
  assert.equal(verifyWebhookSignature(body, "sha256=00", "hook-secret"), false);
  assert.equal(verifyWebhookSignature(body, signature, "wrong"), false);
  assert.equal(verifyWebhookSignature(body, `${signature}zz`, "hook-secret"), false);
  assert.equal(verifyWebhookSignature(body, "sha256=abc", "hook-secret"), false);
});

test("artifact adapter uses content SHA-256 addressing and copies bytes", async () => {
  const store = new LocalArtifactStore(); const bytes = new TextEncoder().encode("evidence");
  const ref = await store.put(bytes, "text/plain");
  assert.equal(ref.sha256, createHash("sha256").update(bytes).digest("hex"));
  bytes[0] = 0;
  assert.equal(new TextDecoder().decode(await store.get(ref.key)), "evidence");
});

test("R2 adapter sends immutable digest-addressed PUT and verifies GET bytes through its request boundary", async () => {
  const bytes = new TextEncoder().encode("retained evidence");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const commands: Array<PutObjectCommand | GetObjectCommand> = [];
  const adapter = createR2ArtifactStore({ accountId: "a".repeat(32), accessKeyId: "fake", secretAccessKey: "fake", bucket: "evidence" }, {
    async send(command) {
      commands.push(command);
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => bytes } };
      return {};
    }
  });
  const ref = await adapter.put(bytes, "text/plain");
  assert.equal(ref.key, `sha256/${hash}`);
  const put = commands[0] as PutObjectCommand;
  assert.equal(put.input.IfNoneMatch, "*");
  assert.equal(put.input.Metadata?.sha256, hash);
  assert.equal(put.input.Bucket, "evidence");
  assert.deepEqual(await adapter.get(ref.key), bytes);
  assert(commands[1] instanceof GetObjectCommand);
  assert.equal(commands[1]?.input.Key, ref.key);
  await assert.rejects(adapter.get("sha256/not-a-digest"), /Invalid artifact key/);
  const bad = createR2ArtifactStore({ accountId: "a".repeat(32), accessKeyId: "fake", secretAccessKey: "fake", bucket: "evidence" }, {
    async send() { return { Body: { transformToByteArray: async () => new TextEncoder().encode("altered") } }; }
  });
  await assert.rejects(bad.get(ref.key), /digest does not match/);
});

test("GitHub App token request uses app client and explicit repository and permission scope", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const adapter = createGitHubAppAdapter({ appId: 123, privateKey: "fake-key-for-injected-boundary" }, {
    app: { async request(route, parameters) { calls.push({ route, parameters }); return { data: { token: "fake-install-token" } }; } },
    async installation() { return { async request(route, parameters) { calls.push({ route, parameters }); return { data: {} }; } }; }
  });
  assert.equal(await adapter.createInstallationToken(44, ["allowed-repo"]), "fake-install-token");
  assert.equal(calls[0]?.route, "POST /app/installations/{installation_id}/access_tokens");
  assert.deepEqual(calls[0]?.parameters.repositories, ["allowed-repo"]);
  assert.deepEqual(calls[0]?.parameters.permissions, { contents: "read", checks: "write" });
  await adapter.createCheckRun(44, "owner/repo", "a".repeat(40), "Forge", "success");
  assert.equal(calls[1]?.route, "POST /repos/{owner}/{repo}/check-runs");
  await assert.rejects(adapter.createInstallationToken(44, ["../outside"]), /scope/);
});

test("Codex subscription adapter passes explicit isolated environment and ChatGPT-only SDK configuration", async () => {
  let seenEnv: Record<string, string> | undefined;
  let seenConfig: unknown;
  let seenDirectory: string | undefined;
  class FakeSdk {
    constructor(options: { env: Record<string, string>; config: { forced_login_method: "chatgpt" } }) { seenEnv = options.env; seenConfig = options.config; }
    startThread(options: { workingDirectory: string }) { seenDirectory = options.workingDirectory; return { run: async (input: string) => `ok:${input}` }; }
  }
  assert.equal(await createCodexAdapter(FakeSdk, "C:/isolated/work", { PATH: "explicit", CODEX_HOME: "C:/isolated/codex", ORLOOM_WORKER_JOB_DIRECTORY: "C:/isolated/jobs" }).run("bounded prompt"), "ok:bounded prompt");
  assert.deepEqual(seenEnv, { PATH: "explicit", CODEX_HOME: "C:/isolated/codex", ORLOOM_WORKER_JOB_DIRECTORY: "C:/isolated/jobs" }); assert.equal(seenDirectory, "C:/isolated/work");
  assert.deepEqual(seenConfig, { forced_login_method: "chatgpt" });
  await assert.rejects(createCodexAdapter(FakeSdk, "C:/isolated/work", { CODEX_HOME: "C:/isolated/codex", ORLOOM_WORKER_JOB_DIRECTORY: "C:/isolated/jobs", CODEX_API_KEY: "x" }).run("no"), /API key environment/);
  await assert.rejects(createCodexAdapter(FakeSdk, "C:/isolated/work", { CODEX_HOME: "C:/isolated/codex", ORLOOM_WORKER_JOB_DIRECTORY: "C:/isolated/jobs", OPENAI_API_KEY: "private-value" }).run("no"), error => !(error as Error).message.includes("private-value"));
  await assert.rejects(createCodexAdapter(FakeSdk, "C:/isolated/work", { PATH: "explicit" }).run("no"), /absolute CODEX_HOME/);
  await assert.rejects(createCodexAdapter(FakeSdk, "/srv/jobs/run", { CODEX_HOME: "/srv/jobs/../jobs/.codex", ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs" }).run("no"), /outside the job workspace/);
  await assert.rejects(createCodexAdapter(FakeSdk, "/srv/jobs/run", { CODEX_HOME: "/", ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs" }).run("no"), /outside the job workspace/);
  let constructorCalls = 0;
  class CountingSdk extends FakeSdk { constructor(options: { env: Record<string, string>; config: { forced_login_method: "chatgpt" } }) { super(options); constructorCalls++; } }
  await assert.rejects(createCodexAdapter(CountingSdk, "/srv/codex/run", { CODEX_HOME: "/srv/codex", ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs" }).run("no"), /outside the job workspace/);
  await assert.rejects(createCodexAdapter(CountingSdk, "relative/run", { CODEX_HOME: "/srv/codex", ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs" }).run("no"), /outside the job workspace/);
  assert.equal(constructorCalls, 0);
  assert.equal(await createCodexAdapter(FakeSdk, "/srv/jobs/run", { CODEX_HOME: "/srv/codex", ORLOOM_WORKER_JOB_DIRECTORY: "/srv/jobs" }).run("posix"), "ok:posix");
  assert.equal(await createCodexAdapter(FakeSdk, "C:/runner/jobs/work", { CODEX_HOME: "C:/runner/codex", ORLOOM_WORKER_JOB_DIRECTORY: "C:/runner/jobs" }).run("windows"), "ok:windows");
  assert.equal(typeof createCodexSdkAdapter, "function");
});

test("cloud mode fails closed without explicit database URL, host, token, and HTTPS origin", () => {
  assert.throws(() => loadConfig({ ORLOOM_MODE: "cloud", ORLOOM_SESSION_TOKEN: "x", ORLOOM_HOST: "orloom.example", ORLOOM_PUBLIC_ORIGIN: "https://orloom.example" }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ ORLOOM_MODE: "cloud", ORLOOM_SESSION_TOKEN: "x", ORLOOM_DATABASE_URL: "postgres://db", ORLOOM_PUBLIC_ORIGIN: "https://orloom.example" }), /ORLOOM_HOST/);
  assert.throws(() => loadConfig({ ORLOOM_MODE: "cloud", ORLOOM_SESSION_TOKEN: "x", ORLOOM_DATABASE_URL: "postgres://db", ORLOOM_HOST: "orloom.example", ORLOOM_PUBLIC_ORIGIN: "http://orloom.example" }), /ORLOOM_PUBLIC_ORIGIN/);
});

test("PostgreSQL job store refuses readiness when the database is unreachable", async () => {
  const { PostgresJobStore } = await import("../packages/contracts/src/postgres-store.js");
  await assert.rejects(PostgresJobStore.connect("postgres://orloom_app:test@127.0.0.1:1/orloom"));
});
