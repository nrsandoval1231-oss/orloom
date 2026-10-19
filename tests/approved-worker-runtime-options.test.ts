import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedRuntimeOptions } from "../apps/worker/src/approved-runtime-options.js";

const checkoutTokens = {} as never;
const checks = {};
const base = { imageRef: `sha256:${"a".repeat(64)}`, installationId: 1, checkoutTokens, checks };

test("approved runtime options are a frozen snapshot with the validated profile and original dependencies", () => {
  const options = approvedRuntimeOptions(base, "orloom-execution-v1");
  assert.equal(Object.isFrozen(options), true);
  assert.equal(options.imageRef, base.imageRef);
  assert.equal(options.installationId, base.installationId);
  assert.equal(options.checks, checks);
  assert.equal(options.checkoutTokens, checkoutTokens);
  assert.equal(options.executionInputProfile, "orloom-execution-v1");
});

test("approved runtime options stay frozen and preserve the default when no profile is configured", () => {
  const options = approvedRuntimeOptions(base);
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.hasOwn(options, "executionInputProfile"), false);
});
