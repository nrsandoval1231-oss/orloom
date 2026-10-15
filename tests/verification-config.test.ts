import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTrustedVerificationRunner } from "../apps/verifier/src/index.js";

const image = `sha256:${"a".repeat(64)}`;
const env = (artifactRoot: string, objectStore: string): NodeJS.ProcessEnv => ({
  ORLOOM_VERIFIER_IMAGE: image, ORLOOM_VERIFIER_ID: "test-verifier", ORLOOM_VERIFIER_ARTIFACT_ROOT: artifactRoot,
  ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({ "owner/repo": { objectStore, approvedRef: "refs/heads/main" } }),
  ORLOOM_CANDIDATE_ADMISSION_ROOT: path.join(parent, "candidate-admissions"),
  ORLOOM_R2_ACCOUNT_ID: "a".repeat(32), ORLOOM_R2_ACCESS_KEY_ID: "fixture-access-key", ORLOOM_R2_SECRET_ACCESS_KEY: "fixture-secret-key", ORLOOM_R2_BUCKET: "orloom-candidates",
});
const parent = path.dirname(process.cwd());

test("factory stays disabled without explicit configuration and builds a valid runner", async () => {
  assert.equal(await createTrustedVerificationRunner({}), null);
  const runner = await createTrustedVerificationRunner(env(path.join(parent, "persistent-artifacts"), path.join(parent, "object-store.git")));
  assert.equal(runner?.constructor.name, "AdmittingVerificationRunner");
});

test("blank sample environment plus owner session token and R2-only settings do not activate verification", async () => {
  const sample = parseEnv(readFileSync(path.join(process.cwd(), ".env.example"), "utf8"));
  assert.equal(await createTrustedVerificationRunner({ ...sample, ORLOOM_SESSION_TOKEN: "fixture-owner-token" }), null);
  assert.equal(await createTrustedVerificationRunner({ ORLOOM_R2_ACCOUNT_ID: "a".repeat(32), ORLOOM_R2_ACCESS_KEY_ID: "fixture-access-key", ORLOOM_R2_SECRET_ACCESS_KEY: "fixture-secret-key", ORLOOM_R2_BUCKET: "orloom-candidates" }), null);
});

test("R2 file secret settings are resolved securely and invalid files override raw values", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "orloom-verifier-secrets-"));
  try {
    const accessFile = path.join(directory, "access-key"), secretFile = path.join(directory, "secret-key");
    writeFileSync(accessFile, "fixture-access-from-file\n", { mode: 0o600 });
    writeFileSync(secretFile, "fixture-secret-from-file\n", { mode: 0o600 });
    const valid = env(path.join(parent, "persistent-artifacts"), path.join(parent, "object-store.git"));
    delete valid.ORLOOM_R2_ACCESS_KEY_ID; delete valid.ORLOOM_R2_SECRET_ACCESS_KEY;
    valid.ORLOOM_R2_ACCESS_KEY_ID_FILE = accessFile; valid.ORLOOM_R2_SECRET_ACCESS_KEY_FILE = secretFile;
    assert.equal((await createTrustedVerificationRunner(valid))?.constructor.name, "AdmittingVerificationRunner");
    const invalidFile = { ...valid, ORLOOM_R2_ACCESS_KEY_ID: "fixture-raw-fallback", ORLOOM_R2_ACCESS_KEY_ID_FILE: path.join(directory, "missing-secret") };
    await assert.rejects(createTrustedVerificationRunner(invalidFile), error => {
      assert.match((error as Error).message, /ORLOOM_R2_ACCESS_KEY_ID_FILE/);
      assert.doesNotMatch((error as Error).message, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch((error as Error).message, /fixture-raw-fallback|fixture-secret/);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("partial or malformed admission configuration fails closed", async () => {
  const valid = env(path.join(parent, "persistent-artifacts"), path.join(parent, "object-store.git"));
  const partial = {...valid}; delete partial.ORLOOM_R2_SECRET_ACCESS_KEY;
  await assert.rejects(createTrustedVerificationRunner(partial), /configuration must be complete/);
  const badAccount = {...valid, ORLOOM_R2_ACCOUNT_ID:"bad"};
  await assert.rejects(createTrustedVerificationRunner(badAccount), /R2 candidate artifact configuration/);
  const overlapping = {...valid, ORLOOM_CANDIDATE_ADMISSION_ROOT:path.join(parent, "persistent-artifacts", "admissions")};
  await assert.rejects(createTrustedVerificationRunner(overlapping), /roots must be separate/);
});

test("rejects artifact roots equal to or below source root and relative roots", async () => {
  const objectStore = path.join(parent, "object-store.git");
  await assert.rejects(createTrustedVerificationRunner(env(process.cwd(), objectStore)), /artifact root/);
  await assert.rejects(createTrustedVerificationRunner(env(path.join(process.cwd(), "nested-artifacts"), objectStore)), /artifact root/);
  await assert.rejects(createTrustedVerificationRunner(env("relative-artifacts", objectStore)), /artifact root/);
});

test("rejects temporary paths, overlap in either direction, and malformed maps", async () => {
  const artifacts = path.join(parent, "persistent-artifacts"), outside = path.join(parent, "object-store.git");
  await assert.rejects(createTrustedVerificationRunner(env(path.join(path.parse(process.cwd()).root, "tmp", "orloom-artifacts"), outside)), /artifact root/);
  await assert.rejects(createTrustedVerificationRunner(env(artifacts, path.join(artifacts, "objects.git"))), /object stores/);
  await assert.rejects(createTrustedVerificationRunner(env(path.join(artifacts, "nested"), artifacts)), /object stores/);
  await assert.rejects(createTrustedVerificationRunner(env(artifacts, process.cwd())), /object stores/);
  const malformed = env(artifacts, outside);
  malformed.ORLOOM_VERIFIER_REPOSITORIES = JSON.stringify({ "Owner/repo": { objectStore: outside, approvedRef: "refs/heads/../main" } });
  await assert.rejects(createTrustedVerificationRunner(malformed), /map entry/);
});
