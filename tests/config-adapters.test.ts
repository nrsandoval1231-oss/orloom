import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { assertRoleConfig, loadConfig, validateRoleConfig } from "../packages/config/src/config.js";
import { createCodexAdapter, createGitHubAppAdapter, createR2ArtifactStore, LocalArtifactStore, verifyWebhookSignature } from "../packages/adapters/src/providers.js";
import { createCodexSdkAdapter } from "../packages/adapters/src/codex-sdk.js";

test("configuration validates roles and does not reveal configured values in errors", () => {
  assert.equal(loadConfig({ ORLOOM_MODE: "local", PORT: "3210" }).port, 3210);
  assert.throws(() => loadConfig({ ORLOOM_MODE: "cloud", ORLOOM_DATABASE_URL: "" }), /requires ORLOOM_DATABASE_URL/);
  assert.throws(() => loadConfig({ ORLOOM_MODE: "production-secret" }), /ORLOOM_MODE must be local or cloud/);
  const github = validateRoleConfig("github", { ORLOOM_GITHUB_APP_ID: "not-a-number-secret", ORLOOM_GITHUB_PRIVATE_KEY: "private-value", ORLOOM_GITHUB_WEBHOOK_SECRET: "hook-value" });
  assert.deepEqual(github.missingFields, ["ORLOOM_GITHUB_APP_ID"]);
  assert.throws(() => assertRoleConfig("artifact", { ORLOOM_R2_ACCOUNT_ID: "private-account-secret" }), error => {
    assert.match((error as Error).message, /ORLOOM_R2_ACCESS_KEY_ID/);
    assert.doesNotMatch((error as Error).message, /private-account-secret/);
    return true;
  });
  assert.equal(validateRoleConfig("worker", { ORLOOM_WORKER_CONTROL_URL: "https://worker.example", ORLOOM_WORKER_TOKEN: "x", ORLOOM_WORKER_JOB_DIRECTORY: "C:/isolated", CODEX_API_KEY: "x" }).ok, true);
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

test("Codex adapter passes explicit environment and working directory to the real SDK constructor contract", async () => {
  let seenEnv: Record<string, string> | undefined;
  let seenDirectory: string | undefined;
  class FakeSdk {
    constructor(options: { env: Record<string, string> }) { seenEnv = options.env; }
    startThread(options: { workingDirectory: string }) { seenDirectory = options.workingDirectory; return { run: async (input: string) => `ok:${input}` }; }
  }
  assert.equal(await createCodexAdapter(FakeSdk, "C:/isolated/work", { PATH: "explicit" }).run("bounded prompt"), "ok:bounded prompt");
  assert.deepEqual(seenEnv, { PATH: "explicit" }); assert.equal(seenDirectory, "C:/isolated/work");
  assert.equal(typeof createCodexSdkAdapter, "function");
});
  assert.deepEqual(validateRoleConfig("control-plane", {}).missingFields, ["ORLOOM_SESSION_TOKEN"]);
  assert.deepEqual(validateRoleConfig("github", {}).missingFields, ["ORLOOM_GITHUB_APP_ID", "ORLOOM_GITHUB_PRIVATE_KEY", "ORLOOM_GITHUB_WEBHOOK_SECRET"]);
  assert.deepEqual(validateRoleConfig("artifact", {}).missingFields, ["ORLOOM_R2_ACCOUNT_ID", "ORLOOM_R2_ACCESS_KEY_ID", "ORLOOM_R2_SECRET_ACCESS_KEY", "ORLOOM_R2_BUCKET"]);
  assert.deepEqual(validateRoleConfig("worker", {}).missingFields, ["ORLOOM_WORKER_CONTROL_URL", "ORLOOM_WORKER_TOKEN", "ORLOOM_WORKER_JOB_DIRECTORY", "CODEX_API_KEY"]);
