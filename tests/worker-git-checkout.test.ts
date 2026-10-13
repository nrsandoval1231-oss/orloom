import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { checkoutExact } from "../packages/agents/src/github-checkout.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (part: Buffer) => stdout.push(part));
    child.stderr.on("data", (part: Buffer) => stderr.push(part));
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8").trim()) : reject(new Error(Buffer.concat(stderr).toString("utf8").slice(0, 1_000))));
  });
}

test("exact checkout fetch seam uses a local Git fixture but retains immutable HEAD verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orloom-checkout-fixture-"));
  const source = path.join(root, "source"), alternate = path.join(root, "alternate");
  await mkdir(source); await mkdir(alternate);
  let checkout: Awaited<ReturnType<typeof checkoutExact>> | undefined;
  try {
    for (const directory of [source, alternate]) {
      await git(["init", "--quiet"], directory);
      await git(["config", "user.name", "Orloom Fixture"], directory);
      await git(["config", "user.email", "fixture@orloom.invalid"], directory);
    }
    await writeFile(path.join(source, "owned.txt"), "expected base\n");
    await git(["add", "--", "owned.txt"], source);
    await git(["commit", "--quiet", "--no-gpg-sign", "-m", "fixture base"], source);
    const baseSha = await git(["rev-parse", "HEAD"], source);
    await writeFile(path.join(alternate, "owned.txt"), "other repository\n");
    await git(["add", "--", "owned.txt"], alternate);
    await git(["commit", "--quiet", "--no-gpg-sign", "-m", "alternate base"], alternate);
    const lease = { protocol: "orloom.worker-lease.v1", mission: { id: "fixture", repository: "owner/repo", baseSha, objective: "fixture", acceptance: ["test"] }, slice: { id: "slice", objective: "fixture", dependencies: [], owner: "builder", scopes: ["owned.txt"], checks: [] }, capacitySlot: 1, leaseEpoch: 1, leaseToken: "lease", capabilityToken: "capability", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), trustedCheckPolicyDigest: "b".repeat(64), planDigest: "c".repeat(64), executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxWallSeconds: 30, allowedProviders: ["deepseek"], allowedModels: ["deepseek-chat"] } } satisfies WorkerLeaseContract;
    let tokenCalls = 0;
    const tokens = { async createCheckoutToken() { tokenCalls++; throw new Error("local fixture must not request credentials"); } };
    checkout = await checkoutExact(lease, 1, tokens, root, undefined, { async fetchExact(request) {
      assert.equal(request.repository, "owner/repo");
      assert.equal(request.baseSha, baseSha);
      await request.fetch(source);
    } });
    assert.equal(checkout.baseSha, baseSha);
    assert.equal(await git(["-C", checkout.directory, "rev-parse", "HEAD"], root), baseSha);
    assert.equal(await readFile(path.join(checkout.directory, "owned.txt"), "utf8"), "expected base\n");
    assert.equal(tokenCalls, 0);
    await checkout.dispose(); checkout = undefined;

    await assert.rejects(checkoutExact(lease, 1, tokens, root, undefined, { async fetchExact(request) { await request.fetch(alternate); } }), /Git exited|not match/);
    assert.equal(tokenCalls, 0);
  } finally {
    await checkout?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
