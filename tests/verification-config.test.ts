import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createTrustedVerificationRunner } from "../apps/verifier/src/index.js";

const image = `sha256:${"a".repeat(64)}`;
const env = (artifactRoot: string, objectStore: string): NodeJS.ProcessEnv => ({
  ORLOOM_VERIFIER_IMAGE: image, ORLOOM_VERIFIER_ID: "test-verifier", ORLOOM_VERIFIER_ARTIFACT_ROOT: artifactRoot,
  ORLOOM_VERIFIER_REPOSITORIES: JSON.stringify({ "owner/repo": { objectStore, approvedRef: "refs/heads/main" } }),
});
const parent = path.dirname(process.cwd());

test("factory stays disabled without explicit configuration and builds a valid runner", async () => {
  assert.equal(await createTrustedVerificationRunner({}), null);
  const runner = await createTrustedVerificationRunner(env(path.join(parent, "persistent-artifacts"), path.join(parent, "object-store.git")));
  assert.ok(runner);
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
