import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const parent = await mkdtemp(path.join(tmpdir(), "orloom-live-disabled-check-"));
const proofRoot = path.join(parent, `must-not-be-created-${randomUUID()}`);
try {
  const script = path.resolve("work/worker-runtime-proof/prove-broker.mjs");
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ORLOOM_PROOF_MODE: "live", ORLOOM_PROOF_ROOT: proofRoot }
  });
  if (result.error || result.status !== 2 || result.stdout !== "" ||
      !result.stderr.includes("Live proof mode is disabled") ||
      !result.stderr.includes("no credential retrieval, spend-ledger mutation, or provider calls")) {
    throw new Error("live mode did not fail closed with the expected message");
  }
  try {
    await stat(proofRoot);
    throw new Error("live mode created the proof root before rejecting");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  process.stdout.write("PASS: live mode rejected before proof-root creation; no provider output\n");
} finally {
  await rm(parent, { recursive: true, force: true });
}
