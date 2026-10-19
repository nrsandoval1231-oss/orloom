import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { TrustedRuntimeJournalBridge } from "../apps/control-plane/src/trusted-runtime-journal-bridge.js";
import { FileRuntimeJournal } from "../apps/worker/src/runtime-journal.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { runApprovedWorkerLane } from "../apps/control-plane/src/approved-worker-lane.js";
import { runApprovedWorkerService } from "../apps/worker/src/approved-service.js";
import { createCertifiedIntegrationPreparer } from "../apps/worker/src/certified-handoff.js";
import { HttpControlPlane, R2WorkerProgressSink, type WorkerOptions } from "../packages/agents/src/worker.js";
import { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";
import { CandidateAdmission } from "../packages/verification/src/candidate-admission.js";
import { AdmittingVerificationRunner } from "../packages/verification/src/admitting-runner.js";
import { DurableArtifactStore } from "../packages/verification/src/artifact-store.js";
import { getCheckAttemptLifetimeMs, getCheckPolicy } from "../packages/verification/src/policy.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { BareGitFastForwardIntegrator } from "../packages/integration/src/local.js";
import type { DeliveryAuthority, DeliveryCommandV1, DeliveryPolicy } from "../packages/integration/src/delivery.js";
import type { GitHubInstallationClient } from "../packages/adapters/src/providers.js";
import type { IntegrationRequestV1 } from "../packages/contracts/src/mission.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

const exec = promisify(execFile);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function git(root: string, ...args: string[]) {
  return (await exec("git", ["-C", root, "-c", "user.name=Orloom fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" })).stdout.trim();
}

test("controlled approved worker lane submits over HTTP, admits its real Git bundle, certifies the exact SHA, and projects durable Loom events", { skip: process.platform !== "linux" }, async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const root = await mkdtemp(path.join(os.tmpdir(), "orloom-approved-compose-"));
  const work = path.join(root, "worker-repo"), trusted = path.join(root, "trusted.git"), admissions = path.join(root, "admissions"), journalRoot = path.join(root, "journal");
  await mkdir(work); await mkdir(admissions, { mode: 0o700 }); await mkdir(journalRoot, { mode: 0o700 });
  try {
    for (const file of ["001_initial.sql", "002_missions.sql", "003_recovery.sql", "004_verification.sql", "005_learning.sql", "006_integration.sql", "007_delivery.sql", "008_delivery_upload.sql", "009_worker_runtime.sql", "010_cancellation_settlement.sql"]) await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
    let gate = Promise.resolve();
    const sql: TransactionalSql = {
      query: async (text, params) => await db.query(text, params as never) as never,
      transaction: async work => {
        let release!: () => void; const prior = gate; gate = new Promise<void>(resolve => { release = resolve; }); await prior;
        try { await db.exec("BEGIN"); const value = await work({ query: async (text, params) => await db.query(text, params as never) as never }); await db.exec("COMMIT"); return value; }
        catch (error) { await db.exec("ROLLBACK"); throw error; } finally { release(); }
      },
    };
    const store = new SqlMissionStore(sql);
    const checkId = "node-repo-suite-v1", checks = [checkId], policyDigest = hash(JSON.stringify(checks)), imageDigest = "a".repeat(64), image = `sha256:${imageDigest}`, verifierId = "controlled-fixture-verifier";
    await store.configureCapacity(1, hash("fixture-capacity"), new Date(Date.now() + 300_000).toISOString());

    // Make a genuine one-parent candidate commit and bundle. The trusted bare store contains only the approved base.
    await git(work, "init", "-b", "main"); await mkdir(path.join(work, "src")); await writeFile(path.join(work, "src", "a.js"), "export const value = 1;\n"); await git(work, "add", "."); await git(work, "commit", "-m", "approved base");
    const baseSha = await git(work, "rev-parse", "HEAD"); await git(root, "clone", "--bare", work, trusted);
    await writeFile(path.join(work, "src", "a.js"), "export const value = 2;\n"); await git(work, "commit", "-am", "fixture candidate");
    const candidateSha = await git(work, "rev-parse", "HEAD"); await git(work, "update-ref", "refs/heads/orloom-candidate", candidateSha);
    const bundleFile = path.join(root, "candidate.bundle"); await git(work, "bundle", "create", bundleFile, "refs/heads/orloom-candidate", `^${baseSha}`); const candidateBundle = await readFile(bundleFile);
    const integrationStore = path.join(root, "integration.git"), remote = path.join(root, "remote.git"), template = path.join(root, "empty-template");
    await mkdir(template); await git(root, "clone", "--bare", `--template=${template}`, trusted, integrationStore);
    await git(integrationStore, "update-ref", "refs/heads/orloom-integration", baseSha);
    await git(root, "init", "--bare", `--template=${template}`, remote);
    await git(remote, "fetch", trusted, `${baseSha}:refs/heads/main`);
    await git(remote, "update-ref", "refs/heads/main", baseSha);
    await assert.rejects(exec("git", ["--git-dir", integrationStore, "cat-file", "-e", candidateSha], { encoding: "utf8" }), "candidate objects are absent before the production handoff");

    const ownerToken = "test-owner-token", workerToken = "test-worker-bootstrap-token", model = "controlled-fixture-model";
    const options: WorkerOptions = {
      allowedModels: [model], allowedProviders: ["deepseek"], trustedChecks: checks, trustedCheckPolicyDigest: policyDigest,
      trustedCheckCommands: { [checkId]: { executable: "node", args: ["fixture-check"], timeoutSeconds: 10 } },
      sandboxImageRef: `sha256:${"d".repeat(64)}`, maxToolCalls: 3,
      pricing: { model, version: "fixture-v1", source: "test fixture", capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(), inputCentsPerMillion: 1, outputCentsPerMillion: 1, reasoningCentsPerMillion: 1, safetyMultiplier: 1.25 },
    };
    const config = {
      mode: "local" as const, port: 0, sessionToken: ownerToken, workerToken, maxLanes: 1, capacitySlots: 1,
      trustedCheckPolicy: checks, trustedCheckPolicyDigest: policyDigest, workerMaxProviderCalls: 4, workerMaxInputTokens: 100_000,
      workerMaxOutputTokens: 100, workerMaxWallSeconds: 60, workerAllowedProviders: ["deepseek"], workerAllowedModels: [model],
    };
    const server = createControlPlane(config, new MemoryJobStore(), store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); assert(address && typeof address !== "string"); const baseUrl = `http://127.0.0.1:${address.port}`;
      const session = await fetch(`${baseUrl}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) }); assert.equal(session.status, 204);
      const cookie = session.headers.get("set-cookie")?.split(";")[0]; assert(cookie);
      const ownerFetch = (url: string, method = "GET", body?: unknown) => fetch(`${baseUrl}${url}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const created = await ownerFetch("/api/missions", "POST", { repository: "owner/repo", baseSha, objective: "produce one scoped source edit", acceptance: ["independent verifier admits and checks exact candidate"], budgetCents: 100 }); assert.equal(created.status, 201);
      const mission = await created.json() as { id: string };
      const slice = { id: "slice", objective: "edit src/a.js", dependencies: [], owner: "core", scopes: ["src"], checks, budgetCents: 100 };
      const planResponse = await ownerFetch(`/api/missions/${mission.id}/plan`, "POST", { slices: [slice] }); assert.equal(planResponse.status, 201);
      assert.equal((await ownerFetch(`/api/missions/${mission.id}/approve`, "POST", {})).status, 200);

      const artifacts = new Map<string, Buffer>();
      const evidence = {
        async put(bytes: Uint8Array) { const copy = Buffer.from(bytes), digest = hash(copy), key = `sha256/${digest}`; artifacts.set(key, copy); return { key, sha256: digest }; },
        async get(key: string) { const value = artifacts.get(key); assert(value, `fixture artifact ${key} exists`); return new Uint8Array(value); },
      };
      const admission = new CandidateAdmission({ root: admissions, repositories: { "owner/repo": { objectStore: trusted, approvedRef: "refs/heads/main" } }, artifacts: { async getBounded(key, max) { const value = artifacts.get(key); if (!value || value.length > max) throw new Error("controlled fixture artifact unavailable"); return new Uint8Array(value); } } });
      const policy = getCheckPolicy(checkId, image, imageDigest);
      let verifierLaunches = 0;
      const runner = new AdmittingVerificationRunner({ repositories: { "owner/repo": { objectStore: trusted, approvedRef: "refs/heads/main" } }, artifacts: new DurableArtifactStore(path.join(root, "verification-evidence")), verifierId, image, imageDigest, launcher: { async launch(_policy, input) { verifierLaunches++; assert.equal(input.files.get("src/a.js")?.toString(), "export const value = 2;\n"); return { sandboxId: "controlled-fixture-only", exitCode: 0, stdout: Buffer.from("fixture verifier passed"), stderr: Buffer.alloc(0) }; } } }, admission);
      const coordinator = new TrustedCheckCoordinator(store, runner, { imageDigest, verifierId, policyDigest: policy.digest, leasePolicyDigest: policyDigest, policyVersion: policy.version, allowedChecks: [checkId], attemptLifetimeMs: getCheckAttemptLifetimeMs(checkId) });
      const control = new HttpControlPlane(baseUrl, workerToken);
      const runtimeJournal = new TrustedRuntimeJournalBridge(await FileRuntimeJournal.openPortableTestRoot(journalRoot), store);
      let providerCompletions = 0;
      const provider = {
        async listModels() { return [model]; }, async probeTools() { return { model, inputTokens: 1, outputTokens: 1 }; },
        async complete(_model: string, messages: unknown[], _signal: AbortSignal, _max: number) {
          providerCompletions++;
          const calls = messages.filter((row: any) => row.role === "assistant").length;
          if (calls === 0) return { model, inputTokens: 5, outputTokens: 2, message: { role: "assistant" as const, content: null, tool_calls: [
            { id: "patch", type: "function" as const, function: { name: "apply_patch", arguments: JSON.stringify({ path: "src/a.js", oldText: "export const value = 1;\n", newText: "export const value = 2;\n" }) } },
            { id: "check", type: "function" as const, function: { name: "run_check", arguments: JSON.stringify({ checkId }) } },
          ] } };
          return { model, inputTokens: 5, outputTokens: 2, message: { role: "assistant" as const, content: "candidate ready" } };
        },
      };
      const createRuntime = (_journal: TrustedRuntimeJournalBridge) => ({ async create(_lease: WorkerLeaseContract) { let source = "export const value = 1;\n"; return {
        async checkout(repository: string, sha: string) { assert.equal(repository, "owner/repo"); assert.equal(sha, baseSha); },
        async readFile(file: string) { assert.equal(file, "src/a.js"); return source; }, async listFiles() { return ["src/a.js"]; },
        async replaceText(_file: string, oldText: string, newText: string) { assert.equal(source, oldText); source = newText; },
        async runCheck(id: string) { assert.equal(id, checkId); const output = "controlled fixture check passed"; return { exitCode: 0, output, outputSha256: hash(output), commandDigest: hash(JSON.stringify(options.trustedCheckCommands[id])), durationMs: 2, imageRef: options.sandboxImageRef }; },
        async commitCandidate() { assert.equal(source, "export const value = 2;\n"); return { candidateSha, diff: Buffer.from("diff --git a/src/a.js b/src/a.js\n-export const value = 1;\n+export const value = 2;\n"), bundle: candidateBundle }; },
        async close() {},
      }; } });
      const planDigest = hash(canonicalJson([slice]));
      const governor = new MissionGovernor(store, { maxLanes: 1, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicy: checks, trustedCheckPolicyDigest: policyDigest, executionConfigured: true });
      const task = { missionId: mission.id, sliceId: slice.id, repository: "owner/repo", baseSha, planDigest, trustedCheckPolicyDigest: policyDigest, maxBudgetCents: 100, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const executionLimits = { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens: 100_000, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: [model] };
      let laneRuns = 0;
      const executeLane = async (lease: WorkerLeaseContract) => {
        laneRuns++;
        return runApprovedWorkerLane(lease, {
          store, binding: { missionId: lease.mission.id, slice, baseSha, planDigest: lease.planDigest, trustedCheckPolicyDigest: policyDigest },
          control, provider, createRuntime, evidence, progress: new R2WorkerProgressSink(evidence), checks: { [checkId]: ["fixture"] }, options,
          trustedChecks: coordinator, runtimeJournal,
        });
      };
      const treeSha = await git(work, "rev-parse", `${candidateSha}^{tree}`);
      const reviewArtifactId = "independent-review-fixture";
      const reviewBytes = Buffer.from(canonicalJson({ version: "orloom.independent-review.v1", verdict: "PASS", candidateSha, treeSha, reviewer: "independent-reviewer", builder: slice.owner, scopes: slice.scopes }));
      const reviewDigest = hash(reviewBytes);
      const reviews = { async read(id: string) { return id === reviewArtifactId ? reviewBytes : null; } };
      const integrator = await BareGitFastForwardIntegrator.openWithTestRemote(integrationStore, "owner/repo", pathToFileURL(remote).href);
      const integrationAuthority = { integrator, reviews };
      const integrationRequest: IntegrationRequestV1 = { version: "orloom.integration-request.v1", missionId: mission.id, sliceId: slice.id, expectedIntegrationSha: baseSha, candidateSha, leaseEpoch: 1, requiredCheckIds: checks, reviewArtifactId, reviewArtifactDigest: reviewDigest };
      const deliveryPolicy: DeliveryPolicy = { repository: "owner/repo", appId: 7, installationId: 9, baseRef: "main", baseSha, protectedRefs: ["main"], checkIds: checks, policyVersion: policy.version, policyDigest: policy.digest, imageDigest, checkName: "Orloom certified suite" };
      const deliveryCommand: DeliveryCommandV1 = { version: "orloom.delivery-command.v1", missionId: mission.id, sliceId: slice.id, leaseEpoch: 1, integratedSha: candidateSha, treeSha, reviewArtifactId, reviewArtifactDigest: reviewDigest, idempotencyKey: "approved-worker-fixture-000001" };
      const checkRuns = new Map<number, any>(), pullRequests = new Map<number, any>();
      const github = {
        appId: deliveryPolicy.appId,
        withContentsWriteToken: async (_installationId: number, _repo: string, action: (token: string) => Promise<unknown>) => action("controlled-fixture-token"),
        createInstallationToken: async () => "controlled-fixture-token",
        inspectBranch: async (_installationId: number, _repo: string, ref: string) => {
          const result = await exec("git", ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${ref}`], { encoding: "utf8" }).catch(() => null);
          if (!result) return null;
          const sha = result.stdout.trim(), tree = await git(remote, "rev-parse", `${sha}^{tree}`);
          return { sha, treeSha: tree };
        },
        listCheckRuns: async () => [...checkRuns.values()],
        createDeliveryCheck: async (_id: number, _repo: string, headSha: string, name: string, externalId: string) => { const row = { id: 17, headSha, name, externalId, conclusion: "success", appId: deliveryPolicy.appId }; checkRuns.set(row.id, row); return row; },
        getCheckRun: async (_id: number, _repo: string, id: number) => checkRuns.get(id),
        listPullRequests: async () => [...pullRequests.values()],
        createDraftPullRequest: async (_id: number, _repo: string, headRef: string, baseRef: string) => { const row = { number: 23, draft: true, state: "open", merged: false, headRepository: "owner/repo", headRef, headSha: candidateSha, baseRepository: "owner/repo", baseRef, baseSha }; pullRequests.set(row.number, row); return row; },
        getPullRequest: async (_id: number, _repo: string, number: number) => pullRequests.get(number),
        createCheckRun: async () => undefined,
      } as unknown as GitHubInstallationClient;
      const deliveryAuthority: DeliveryAuthority = { integrator, reviews, artifacts: evidence, github };
      const prepareCertifiedIntegration = createCertifiedIntegrationPreparer({ store, coordinator, admittingRunner: runner, integrator, artifacts: evidence, reviews });
      const commonDeps = { governor, store, trustedChecks: coordinator, async reconcileInterrupted() {}, async reconcileRetained() {}, executeLane, integrationAuthority, prepareCertifiedIntegration };
      const serviceOptions = { task, executionLimits, minimumSliceBudgetCents: 1, leaseSeconds: 300, integrationRequest, deliveryCommand };

      // The approved service itself claims and runs the worker. Missing delivery authority is a closed gate.
      await assert.rejects(runApprovedWorkerService(serviceOptions, commonDeps), /delivery command lacks controller-owned delivery policy or authority/);
      assert.equal(laneRuns, 1); assert.equal(verifierLaunches, 1);
      assert.equal((await store.getMission(mission.id))?.slices[0]?.status, "awaiting_verification");
      assert.equal(await git(integrationStore, "rev-parse", "refs/heads/orloom-integration"), baseSha);
      await assert.rejects(exec("git", ["--git-dir", integrationStore, "cat-file", "-e", candidateSha], { encoding: "utf8" }));

      // A malformed review reference cannot import/integrate the certificate or reach the delivery adapter.
      const missingReview = { ...integrationRequest, reviewArtifactId: "missing-review", reviewArtifactDigest: hash("missing review") };
      await assert.rejects(runApprovedWorkerService({ ...serviceOptions, integrationRequest: missingReview }, { ...commonDeps, deliveryPolicy, deliveryAuthority }), /review/i);
      assert.equal(await git(integrationStore, "rev-parse", "refs/heads/orloom-integration"), baseSha);
      assert.equal(pullRequests.size, 0);

      const serviceStatus = await runApprovedWorkerService(serviceOptions, { ...commonDeps, deliveryPolicy, deliveryAuthority });
      assert.equal(serviceStatus, "delivered");
      assert.equal(laneRuns, 1, "the service must not reclaim/reexecute after durable verification");
      assert.equal(verifierLaunches, 1, "the service must not repeat the independent check");
      const certificate = await store.getIntegratedCertificate?.(mission.id, slice.id, 1, checkId); assert(certificate);
      assert.equal(certificate.candidateSha, candidateSha); assert.equal(certificate.localHeadSha, candidateSha);
      assert.equal(await git(integrationStore, "rev-parse", "refs/heads/orloom-integration"), candidateSha);
      assert.equal(await git(integrationStore, "rev-parse", `${candidateSha}^{tree}`), treeSha);
      assert.equal(await git(remote, "rev-parse", `refs/heads/${[...pullRequests.values()][0].headRef}`), candidateSha);
      assert.equal(await git(remote, "rev-parse", "refs/heads/main"), baseSha, "protected base ref is unchanged");
      assert.equal(await git(trusted, "rev-parse", "refs/heads/main"), baseSha, "candidate admission leaves trusted base unchanged");
      assert.equal(checkRuns.size, 1); assert.equal(pullRequests.size, 1);
      const effects = await db.query("SELECT effect,state,external_id FROM mission_delivery_effects WHERE mission_id=$1 ORDER BY effect", [mission.id]);
      assert.equal(effects.rows.length, 3, "upload, check and draft PR effects are durably retained");

      const completionCount = providerCompletions;
      const replay = await runApprovedWorkerService(serviceOptions, { ...commonDeps, async executeLane() { throw new Error("verified restart must not invoke provider or builder"); }, deliveryPolicy, deliveryAuthority });
      assert.equal(replay, "delivered"); assert.equal(providerCompletions, completionCount);
      assert.equal(verifierLaunches, 1); assert.equal(checkRuns.size, 1); assert.equal(pullRequests.size, 1);
      const durable = await store.events(mission.id, 0);
      for (const type of ["slice.claimed", "slice.awaiting_verification", "check.certified", "slice.integrated"]) assert(durable.some(event => event.type === type), `SQL event log contains ${type}`);
      const history = await ownerFetch(`/api/missions/${mission.id}/events?after=0`); assert.equal(history.status, 200);
      const projected = await history.json() as Array<{ type: string }>;
      assert(projected.some(event => event.type === "check.certified")); assert(projected.some(event => event.type === "slice.integrated"));
      const loom = await ownerFetch(`/api/missions/${mission.id}/loom`); assert.equal(loom.status, 200);
      const loomBody = await loom.json() as { projection: unknown; events: Array<{ type: string }> };
      assert(loomBody.projection); assert(loomBody.events.some(event => event.type === "check.certified")); assert(loomBody.events.some(event => event.type === "slice.integrated"));
      assert.deepEqual(JSON.parse(canonicalJson((await store.getMission(mission.id))!.plan!.slices)), [slice]);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
