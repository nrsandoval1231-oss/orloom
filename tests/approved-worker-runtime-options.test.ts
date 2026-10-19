import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovedRuntimeComposition } from "../apps/worker/src/approved-runtime-options.js";

const checkoutTokens = {} as never;
const checks = {};
const base = { imageRef: `sha256:${"a".repeat(64)}`, installationId: 1, checkoutTokens, checks };

test("production runtime composition passes one frozen profiled snapshot to reconciliation and execution", async () => {
  const executionOptions: unknown[] = [];
  const composition = createApprovedRuntimeComposition(base, "orloom-execution-v1", {} as never, (_lease, dependencies) => {
    executionOptions.push(dependencies.runtimeOptions);
    return Promise.resolve("unknown");
  });
  await composition.executeLane({} as never, {} as never);
  const options = composition.runtimeOptions;
  assert.equal(Object.isFrozen(options), true);
  assert.equal(executionOptions[0], options);
  assert.equal(options.imageRef, base.imageRef);
  assert.equal(options.installationId, base.installationId);
  assert.equal(options.checks, checks);
  assert.equal(options.checkoutTokens, checkoutTokens);
  assert.equal(options.executionInputProfile, "orloom-execution-v1");
});

test("production runtime composition preserves one frozen snapshot when no profile is configured", async () => {
  const executionOptions: unknown[] = [];
  const composition = createApprovedRuntimeComposition(base, undefined, {} as never, (_lease, dependencies) => {
    executionOptions.push(dependencies.runtimeOptions);
    return Promise.resolve("unknown");
  });
  await composition.executeLane({} as never, {} as never);
  const options = composition.runtimeOptions;
  assert.equal(Object.isFrozen(options), true);
  assert.equal(executionOptions[0], options);
  assert.equal(options.imageRef, base.imageRef);
  assert.equal(options.installationId, base.installationId);
  assert.equal(options.checks, checks);
  assert.equal(options.checkoutTokens, checkoutTokens);
  assert.equal(Object.hasOwn(options, "executionInputProfile"), false);
});
