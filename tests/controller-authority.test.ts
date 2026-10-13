import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../packages/config/src/config.js";
import { getCheckPolicy } from "../packages/verification/src/policy.js";
import { createControllerAuthorities, createReviewArtifactReader } from "../apps/control-plane/src/controller-authority.js";
import type { TrustedCheckCoordinator } from "../packages/governor/src/governor.js";

const suiteImageDigest = createHash("sha256").update("fixture verifier image").digest("hex");
const suiteImage = `registry.example/orloom-verifier@sha256:${suiteImageDigest}`;
const suitePolicy = getCheckPolicy("node-repo-suite-v1", suiteImage, suiteImageDigest);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ORLOOM_MODE: "cloud",
    ORLOOM_DATABASE_URL: "postgres://127.0.0.1/unused-test-db",
    ORLOOM_HOST: "control.example.test",
    ORLOOM_SESSION_TOKEN: "fixture-session-only",
    ORLOOM_PUBLIC_ORIGIN: "https://control.example.test",
    ORLOOM_TRUSTED_CHECK_POLICY_JSON: JSON.stringify(["node-repo-suite-v1"]),
    ORLOOM_VERIFIER_IMAGE: suiteImage,
    ORLOOM_VERIFIER_ID: "fixture-runner",
    ORLOOM_VERIFICATION_POLICY_VERSION: suitePolicy.version,
    ORLOOM_INTEGRATION_ENABLED: "true",
    ORLOOM_INTEGRATION_REPOSITORY: "Acme/Widget",
    ORLOOM_INTEGRATION_BARE_REPOSITORY: "",
    ORLOOM_REVIEW_ARTIFACT_ROOT: "",
    ORLOOM_DELIVERY_ENABLED: "false"
  };
}

test("controller capabilities remain closed by default, including with stray Jev configuration", async () => {
  const config = loadConfig({
    ORLOOM_MODE: "local",
    ORLOOM_SESSION_TOKEN: "local-test",
    ORLOOM_JEV_API_KEY: "must-not-be-read-or-used",
    ORLOOM_JEV_ENABLED: "true"
  });
  assert.equal(config.integrationEnabled, false);
  assert.equal(config.deliveryEnabled, false);
  assert.deepEqual(await createControllerAuthorities(config, {}, { ORLOOM_JEV_API_KEY: "must-not-be-read-or-used" }), {});
  assert.equal(JSON.stringify(config).includes("must-not-be-read-or-used"), false);
});

test("explicit integration and delivery composition binds one repository and full-suite policy without startup calls", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "orloom-controller-authority-"));
  const bare = path.join(dir, "repository.git");
  const reviewRoot = path.join(dir, "reviews");
  const policyFile = path.join(dir, "delivery-policy.json");
  const keyFile = path.join(dir, "github-key.pem");
  const accessFile = path.join(dir, "r2-access");
  const r2SecretFile = path.join(dir, "r2-secret");
  const appSecrets = { app: 12345, privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const r2Access = "fixture-r2-access-key";
  const r2Secret = "fixture-r2-secret-key-not-real";
  try {
    const template = path.join(dir, "empty-template");
    await mkdir(template);
    execFileSync("git", ["init", "--bare", `--template=${template}`, bare], { stdio: "ignore" });
    await mkdir(reviewRoot, { mode: 0o700 });
    const base = baseEnv();
    base.ORLOOM_INTEGRATION_BARE_REPOSITORY = bare;
    base.ORLOOM_REVIEW_ARTIFACT_ROOT = reviewRoot;
    base.ORLOOM_DELIVERY_ENABLED = "true";
    base.ORLOOM_DELIVERY_POLICY_FILE = policyFile;
    base.ORLOOM_GITHUB_APP_ID = String(appSecrets.app);
    await writeFile(keyFile, appSecrets.privateKey, { mode: 0o600 });
    await writeFile(accessFile, r2Access, { mode: 0o600 });
    await writeFile(r2SecretFile, r2Secret, { mode: 0o600 });
    await Promise.all([chmod(keyFile, 0o600), chmod(accessFile, 0o600), chmod(r2SecretFile, 0o600)]);
    base.ORLOOM_GITHUB_PRIVATE_KEY_FILE = keyFile;
    base.ORLOOM_R2_ACCOUNT_ID = "a".repeat(32);
    base.ORLOOM_R2_ACCESS_KEY_ID_FILE = accessFile;
    base.ORLOOM_R2_SECRET_ACCESS_KEY_FILE = r2SecretFile;
    base.ORLOOM_R2_BUCKET = "orloom-test-evidence";
    const config = loadConfig(base);
    const policy = {
      repository: "acme/widget",
      appId: appSecrets.app,
      installationId: 91,
      baseRef: "main",
      baseSha: "a".repeat(40),
      protectedRefs: ["main"],
      checkIds: ["node-repo-suite-v1"],
      policyVersion: suitePolicy.version,
      policyDigest: suitePolicy.digest,
      imageDigest: suitePolicy.imageDigest,
      checkName: "Orloom trusted full suite"
    };
    await writeFile(policyFile, JSON.stringify({ ...policy, repository: "other/repository" }));
    await chmod(policyFile, 0o600);
    await assert.rejects(createControllerAuthorities(config, {
      checkId: "node-repo-suite-v1",
      policy: suitePolicy,
      coordinator: {} as TrustedCheckCoordinator
    }, base), /fixed repository and trusted full-suite policy/);
    await writeFile(policyFile, JSON.stringify({ ...policy, unrecognized: true }));
    await chmod(policyFile, 0o600);
    await assert.rejects(createControllerAuthorities(config, {
      checkId: "node-repo-suite-v1",
      policy: suitePolicy,
      coordinator: {} as TrustedCheckCoordinator
    }, base), /missing or unknown fields/);
    await writeFile(policyFile, JSON.stringify(policy));
    await chmod(policyFile, 0o600);
    const partialSecrets = { ...base, ORLOOM_R2_SECRET_ACCESS_KEY_FILE: undefined };
    await assert.rejects(createControllerAuthorities(config, {
      checkId: "node-repo-suite-v1",
      policy: suitePolicy,
      coordinator: {} as TrustedCheckCoordinator
    }, partialSecrets), error => {
      assert.equal((error as Error).message.includes(r2Secret), false);
      return /R2 account, key, secret, and bucket fields/.test((error as Error).message);
    });
    const composed = await createControllerAuthorities(config, {
      checkId: "node-repo-suite-v1",
      policy: suitePolicy,
      coordinator: {} as TrustedCheckCoordinator
    }, base);
    assert.equal(composed.localIntegration?.integrator.repositoryIdentity, "acme/widget");
    assert.equal(composed.deliveryController?.policy.repository, "acme/widget");
    assert.deepEqual(composed.deliveryController?.policy.checkIds, ["node-repo-suite-v1"]);
    assert.equal(JSON.stringify(config).includes(appSecrets.privateKey), false);
    assert.equal(JSON.stringify(config).includes(r2Secret), false);
    assert.equal(JSON.stringify(config).includes(r2Access), false);
    assert.equal(JSON.stringify(composed).includes(appSecrets.privateKey), false);
    assert.equal(JSON.stringify(composed).includes(r2Secret), false);
    assert.equal(JSON.stringify(composed).includes(r2Access), false);
    await assert.rejects(createControllerAuthorities(config, { checkId: "node-validate-syntax", policy: suitePolicy, coordinator: {} as TrustedCheckCoordinator }, base), /trusted node-repo-suite-v1 verifier/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review reader accepts only private bounded files beneath its fixed root", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "orloom-review-reader-"));
  const root = path.join(dir, "reviews");
  const outside = path.join(dir, "outside.json");
  try {
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, "review-001.json"), "{\"verdict\":\"PASS\"}");
    await writeFile(path.join(root, "large.json"), Buffer.alloc(256 * 1024 + 1));
    await writeFile(outside, "outside");
    await chmod(path.join(root, "review-001.json"), 0o600);
    await chmod(path.join(root, "large.json"), 0o600);
    await chmod(outside, 0o600);
    const link = path.join(root, "linked.json");
    let supportsSymlink = true;
    try { await symlink(outside, link, "file"); } catch { supportsSymlink = false; }
    const reader = await createReviewArtifactReader(root);
    assert.equal((await reader.read("review-001"))?.toString(), "{\"verdict\":\"PASS\"}");
    assert.equal(await reader.read("../outside"), null);
    assert.equal(await reader.read("large"), null);
    if (supportsSymlink) assert.equal(await reader.read("linked"), null);
    assert.equal(await reader.read("missing"), null);
    const linkedRoot = path.join(dir, "linked-root");
    if (supportsSymlink) {
      await symlink(root, linkedRoot, "junction");
      await assert.rejects(createReviewArtifactReader(linkedRoot), /private real directory/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enabled configuration rejects partial or unsafe settings without echoing credential values", () => {
  const partial = { ...baseEnv(), ORLOOM_INTEGRATION_BARE_REPOSITORY: undefined };
  assert.throws(() => loadConfig(partial), /ORLOOM_INTEGRATION_BARE_REPOSITORY/);
  assert.throws(() => loadConfig({ ...baseEnv(), ORLOOM_INTEGRATION_ENABLED: "yes" }), /ORLOOM_INTEGRATION_ENABLED/);
  const config = loadConfig({ ORLOOM_MODE: "local", ORLOOM_SESSION_TOKEN: "x" });
  const privateValue = "never-echo-this-test-secret";
  assert.doesNotThrow(() => JSON.stringify(config));
  assert.equal(JSON.stringify(config).includes(privateValue), false);
});
