import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DurableArtifactStore } from "../packages/verification/src/artifact-store.js";
import { TrustedVerificationRunner, type SandboxResult } from "../packages/verification/src/runner.js";
import { getCheckPolicy } from "../packages/verification/src/policy.js";
import type { TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import type { InputBundle } from "../packages/verification/src/repository.js";
import type { LifecycleGuard } from "../packages/contracts/src/lifecycle.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const imageDigest = "0".repeat(64);
const policy = getCheckPolicy("node-validate-syntax");
const bundle: InputBundle = { digest: digest("fixture bundle"), manifest: Buffer.from("fixture manifest"), files: new Map() };
let requestNumber = 0;
function request(expiresAt = new Date(Date.now() + 60_000).toISOString()): TrustedCheckRequestV1 {
  requestNumber++;
  return {
    version: "orloom.trusted-check-request.v1",
    attemptId: `22222222-2222-4222-8222-${String(requestNumber).padStart(12, "0")}`,
    missionId: "11111111-1111-4111-8111-111111111111",
    sliceId: "capacity",
    leaseEpoch: 1,
    repository: "owner/repo",
    candidateSha: "a".repeat(40),
    expectedLocalHeadSha: "a".repeat(40),
    planDigest: digest("plan"),
    checkId: policy.id,
    policyVersion: policy.version,
    policyDigest: policy.digest,
    verifierImageDigest: imageDigest,
    inputBundleDigest: bundle.digest,
    requestedAt: new Date(Date.parse(expiresAt) - 60_000).toISOString(),
    expiresAt,
  };
}
function result(exitCode: number | null = 0): SandboxResult {
  return { sandboxId: "fixture-sandbox", exitCode, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryArtifacts(options: { failFirstPut?: boolean } = {}): DurableArtifactStore {
  let puts = 0;
  return {
    async put(bytes: Uint8Array) {
      puts++;
      if (options.failFirstPut && puts === 1) throw new Error("simulated artifact persistence failure");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { key: `sha256/${sha256}`, sha256, bytes: bytes.length };
    },
    async verify() { return Buffer.alloc(0); },
    async read() { return Buffer.alloc(0); },
  } as unknown as DurableArtifactStore;
}
function runner(launch: (checkPolicy: typeof policy, inputBundle: InputBundle) => Promise<SandboxResult>, options: { artifacts?: DurableArtifactStore; now?: () => Date } = {}) {
  return new TrustedVerificationRunner({
    repositories: {}, artifacts: options.artifacts ?? memoryArtifacts(), launcher: { launch },
    verifierId: "fixture-verifier", image: policy.image, imageDigest,
    ...(options.now ? { now: options.now } : {}),
  });
}

for (const guardMode of ["absent", "delayed"] as const) {
  test(`concurrent ${guardMode} lifecycle checks never exceed one sandbox and release capacity`, async () => {
    const launchGate = deferred<void>();
    const guardEntered = deferred<void>(), guardGate = deferred<void>();
    let guardsEntered = 0, activeLaunches = 0, peakLaunches = 0, launches = 0;
    const guard: LifecycleGuard = guardMode === "delayed" ? async () => {
      guardsEntered++;
      if (guardsEntered === 1) guardEntered.resolve();
      await guardGate.promise;
    } : async () => {};
    const verify = runner(async () => {
      launches++; activeLaunches++; peakLaunches = Math.max(peakLaunches, activeLaunches);
      try { await launchGate.promise; return result(); }
      finally { activeLaunches--; }
    });
    const first = verify.run(request(), bundle, guardMode === "absent" ? undefined : guard);
    let second: Promise<unknown>;
    if (guardMode === "delayed") await guardEntered.promise;
    second = verify.run(request(), bundle, guardMode === "absent" ? undefined : guard);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      guardGate.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(peakLaunches, 1, "maxConcurrent=1 must bound actual launcher overlap");
      assert.equal(launches, 1, "one competing request must be settled without dispatch");
    } finally {
      guardGate.resolve();
      launchGate.resolve();
      await Promise.allSettled([first, second]);
    }
    await verify.run(request(), bundle, guard);
    assert.equal(launches, 2, "capacity becomes available after the admitted execution finishes");
    assert.equal(peakLaunches, 1);
  });
}

test("a stopped or rejecting lifecycle guard produces no receipt or sandbox and leaves capacity usable", async () => {
  let launches = 0;
  const verify = runner(async () => { launches++; return result(); });
  await assert.rejects(verify.run(request(), bundle, async () => { throw new Error("lifecycle stopped"); }), /lifecycle stopped/);
  assert.equal(launches, 0, "a rejected checkpoint cannot dispatch a sandbox");
  const receipt = await verify.run(request(), bundle);
  assert.equal(receipt.outcome, "pass", "the caller sees a rejection rather than a receipt for the stopped guard");
  assert.equal(launches, 1, "a rejected guard must not strand execution capacity");
});

test("aborting lifecycle after dispatch retains capacity until the admitted launcher settles", async () => {
  const controller = new AbortController(), launchGate = deferred<void>(), launchStarted = deferred<void>();
  let launches = 0;
  const guard: LifecycleGuard = async () => { if (controller.signal.aborted) throw new Error("lifecycle stopped"); };
  const verify = runner(async () => {
    launches++;
    launchStarted.resolve();
    await launchGate.promise;
    return result();
  });
  const first = verify.run(request(), bundle, guard);
  await launchStarted.promise;
  controller.abort();
  const competing = await verify.run(request(), bundle, guard);
  assert.equal(competing.outcome, "unknown");
  assert.equal(launches, 1, "abort after dispatch cannot free a still-running sandbox slot");
  launchGate.resolve();
  await first;
  const later = await verify.run(request(), bundle);
  assert.equal(later.outcome, "pass");
  assert.equal(launches, 2, "capacity becomes available when the actual launcher settles");
});

test("launcher throws and unknown or failed results release the slot for a later request", async () => {
  for (const firstOutcome of ["throw", "unknown", "failure"] as const) {
    let launches = 0;
    const verify = runner(async () => {
      launches++;
      if (launches === 1 && firstOutcome === "throw") throw new Error("launcher unavailable");
      if (launches === 1 && firstOutcome === "unknown") return { ...result(null), timedOut: true };
      if (launches === 1 && firstOutcome === "failure") return result(2);
      return result();
    });
    const first = await verify.run(request(), bundle);
    assert.equal(first.outcome, firstOutcome === "failure" ? "fail" : firstOutcome === "throw" || firstOutcome === "unknown" ? "unknown" : "pass");
    const later = await verify.run(request(), bundle);
    assert.equal(later.outcome, "pass", `${firstOutcome} must not leak capacity`);
    assert.equal(launches, 2, `${firstOutcome} is followed by a real admitted execution`);
  }
});

test("a request that expires while its lifecycle guard is awaited is not launched", async () => {
  let currentTime = new Date("2030-01-01T00:00:00.000Z"), launches = 0;
  const verify = runner(async () => { launches++; return result(); }, { now: () => currentTime });
  const gate = deferred<void>();
  const pending = verify.run(request("2030-01-01T00:00:01.000Z"), bundle, async () => { await gate.promise; });
  await new Promise<void>(resolve => setImmediate(resolve));
  currentTime = new Date("2030-01-01T00:00:02.000Z");
  gate.resolve();
  const expired = await pending;
  assert.equal(expired.outcome, "unknown");
  assert.equal(launches, 0, "expiration during the guard must be rechecked before dispatch");
  const current = await verify.run(request("2030-01-01T00:01:00.000Z"), bundle);
  assert.equal(current.outcome, "pass");
  assert.equal(launches, 1, "expired pre-dispatch work must leave capacity free");
});

test("artifact persistence failure after execution does not retain execution capacity", async () => {
  let launches = 0;
  const verify = runner(async () => { launches++; return result(); }, { artifacts: memoryArtifacts({ failFirstPut: true }) });
  await assert.rejects(verify.run(request(), bundle), /simulated artifact persistence failure/);
  const later = await verify.run(request(), bundle);
  assert.equal(later.outcome, "pass");
  assert.equal(launches, 2, "artifact failure occurs after execution and must not keep its slot");
});
