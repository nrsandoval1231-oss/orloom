import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import type { SliceInput } from "../packages/contracts/src/mission.js";
import { receiptDigestV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";
import type { GitHubInstallationClient } from "../packages/adapters/src/providers.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { BareGitFastForwardIntegrator } from "../packages/integration/src/local.js";
import type { DeliveryAuthority, DeliveryCommandV1, DeliveryPolicy } from "../packages/integration/src/delivery.js";
import { MissionGovernor, TrustedCheckCoordinator } from "../packages/governor/src/governor.js";

const exec = promisify(callbackExecFile);
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

test("approved trusted C4 integration attribution reaches controlled delivery effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "orloom-delivery-c4-"));
  const db = new PGlite();
  try {
    for (const migration of ["001_initial.sql", "002_missions.sql", "003_recovery.sql", "004_verification.sql", "005_learning.sql", "006_integration.sql", "007_delivery.sql", "008_delivery_upload.sql"]) {
      await db.exec(await readFile(`db/migrations/${migration}`, "utf8"));
    }
    let transactionTail = Promise.resolve();
    const sql: TransactionalSql = {
      query: async (text, params) => await db.query(text, params as never) as never,
      transaction: async <T>(work: (tx: { query: TransactionalSql["query"] }) => Promise<T>) => {
        let release!: () => void;
        const prior = transactionTail;
        transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await prior;
        try {
          await db.exec("BEGIN");
          const result = await work({ query: async (text, params) => await db.query(text, params as never) as never });
          await db.exec("COMMIT");
          return result;
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        } finally { release(); }
      }
    };
    const store = new SqlMissionStore(sql);
    const policyDigest = hash("trusted verifier suite policy"), leasePolicyDigest = hash(JSON.stringify(["node-repo-suite-v1"]));
    await store.configureCapacity(1, hash("capacity evidence"), new Date(Date.now() + 120_000).toISOString());

    const source = join(root, "source"), bare = join(root, "bare.git"), remote = join(root, "destination bare.git"), template = join(root, "empty-template");
    await mkdir(template);
    await exec("git", ["init", "-q", "-b", "main", source], { windowsHide: true, timeout: 15_000 });
    await git(source, ["config", "user.name", "C4 delivery fixture"]);
    await git(source, ["config", "user.email", "c4-delivery@example.invalid"]);
    await writeFile(join(source, "src.txt"), "base\n");
    await git(source, ["add", "src.txt"]);
    await git(source, ["commit", "-qm", "base"]);
    const baseSha = await git(source, ["rev-parse", "HEAD"]);
    await exec("git", ["clone", "-q", "--bare", `--template=${template}`, source, bare], { windowsHide: true, timeout: 15_000 });
    await exec("git", ["init", "-q", "--bare", `--template=${template}`, remote], { windowsHide: true, timeout: 15_000 });
    await exec("git", ["--git-dir",remote,"fetch","-q",bare,`${baseSha}:refs/heads/main`],{windowsHide:true,timeout:15_000});
    await git(bare, ["update-ref", "refs/heads/orloom-integration", baseSha]);
    await writeFile(join(source, "src.txt"), "candidate\n");
    await git(source, ["commit", "-qam", "candidate"]);
    const candidateSha = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "-q", bare, `${candidateSha}:refs/heads/candidate`]);

    const repository = "owner/orloom";
    const integrator = await BareGitFastForwardIntegrator.openWithTestRemote(bare, repository, new URL(`file:///${remote.replaceAll("\\","/")}`).href);
    const inspection = await integrator.inspect({ expectedRefSha: baseSha, candidateSha, scopes: ["src.txt"] });
    const artifacts = new Map<string, Buffer>();
    const artifactRef = (bytes: Buffer): { key: `sha256/${string}`; sha256: string; bytes: number } => {
      const digest = hash(bytes), key = `sha256/${digest}` as `sha256/${string}`;
      artifacts.set(key, bytes);
      return { key, sha256: digest, bytes: bytes.byteLength };
    };
    const mission = await store.submit({ repository, baseSha, objective: "deliver a trusted integrated change", acceptance: ["publish retained proof"], budgetCents: 100 });
    const slices: SliceInput[] = [{ id: "delivery", objective: "change src.txt", dependencies: [], owner: "builder", scopes: ["src.txt"], checks: ["node-repo-suite-v1"], budgetCents: 100 }];
    await store.recommendPlan(mission.id, slices, "owner-session");
    await store.approvePlan(mission.id);

    const governor = new MissionGovernor(store, { maxLanes: 2, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: leasePolicyDigest, trustedCheckPolicy: ["node-repo-suite-v1"], executionConfigured: true });
    const grant = await governor.claim();
    assert(grant);
    assert.equal(grant.mission.id, mission.id);
    assert.equal(grant.slice.id, "delivery");
    const workerBundle = artifactRef(Buffer.from("controlled worker candidate bundle"));
    const workerEvidenceRef = `candidate-bundle:${workerBundle.key}`;
    await governor.complete(mission.id, "delivery", grant.epoch, grant.leaseToken, grant.capabilityToken, candidateSha, [workerEvidenceRef]);
    const runner = {
      prepareBundle: async () => ({ digest: hash("bundle"), manifest: Buffer.from("bundle manifest"), files: new Map([["src.txt", Buffer.from("candidate\n")]]) }),
      observeHead: async (repo: string) => ({ sha: repo === repository ? candidateSha : "", observedAt: new Date().toISOString(), digest: hash(`head:${repo}:${candidateSha}`) }),
      run: async (request: TrustedCheckRequestV1) => {
        const startedAt = new Date().toISOString();
        const body = {
          version: "orloom.trusted-check-receipt.v1" as const,
          request,
          verifierId: "fixture-runner",
          runtime: "runsc" as const,
          sandboxId: "delivery-c4-source-test",
          outcome: "pass" as const,
          exitCode: 0,
          startedAt,
          finishedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
          stdout: artifactRef(Buffer.from("suite output")),
          stderr: artifactRef(Buffer.from("")),
          inputManifest: artifactRef(Buffer.from("input manifest"))
        };
        return { ...body, receiptDigest: receiptDigestV1(body) } satisfies TrustedCheckReceiptV1;
      },
      verifyArtifacts: async (receipt: TrustedCheckReceiptV1) => {
        const stdout = artifacts.get(receipt.stdout.key), stderr = artifacts.get(receipt.stderr.key), manifest = artifacts.get(receipt.inputManifest.key);
        if (!stdout || !stderr || !manifest) throw new Error("fixture artifacts are unavailable");
        return { stdout, stderr, manifest };
      }
    };
    const coordinator = new TrustedCheckCoordinator(store, runner, { imageDigest: hash("runner image"), verifierId: "fixture-runner", policyDigest, leasePolicyDigest, policyVersion: "fixture-policy-v1", allowedChecks: ["node-repo-suite-v1"], attemptLifetimeMs: 60_000 });
    await coordinator.verifySlice(mission.id, "delivery");

    const reviewArtifactId = "independent-review-c4-delivery";
    const reviewBytes = Buffer.from(canonicalJson({ version: "orloom.independent-review.v1", verdict: "PASS", candidateSha, treeSha: inspection.treeSha, reviewer: "separate-reviewer", builder: "builder", scopes: ["src.txt"] }));
    const reviewDigest = hash(reviewBytes);
    const localAuthority = { integrator, reviews: { read: async (id: string) => id === reviewArtifactId ? reviewBytes : null } };
    const integrationRequest = { version: "orloom.integration-request.v1" as const, missionId: mission.id, sliceId: "delivery", expectedIntegrationSha: baseSha, candidateSha, leaseEpoch: grant.epoch, requiredCheckIds: ["node-repo-suite-v1"], reviewArtifactId, reviewArtifactDigest: reviewDigest };
    const integrated = await governor.integrateVerifiedSlice(integrationRequest, coordinator, localAuthority);
    assert.equal(integrated.status, "verified");
    assert.deepEqual(integrated.evidenceRefs, [workerEvidenceRef, `integration:${candidateSha}`, `review:${reviewDigest}`]);

    const deliveryPolicy: DeliveryPolicy = { repository, appId: 7, installationId: 9, baseRef: "main", baseSha, protectedRefs: ["main"], checkIds: ["node-repo-suite-v1"], policyVersion: "fixture-policy-v1", policyDigest, imageDigest: hash("runner image"), checkName: "Orloom certified suite" };
    const command: DeliveryCommandV1 = { version: "orloom.delivery-command.v1", missionId: mission.id, sliceId: "delivery", leaseEpoch: grant.epoch, integratedSha: candidateSha, treeSha: inspection.treeSha, reviewArtifactId, reviewArtifactDigest: reviewDigest, idempotencyKey: "delivery-c4-flow-000001" };

    const checks = new Map<number, { id: number; headSha: string; name: string; externalId: string | null; conclusion: string | null; appId: number | null }>();
    const prs = new Map<number, { number: number; draft: boolean; state: string; merged: boolean; headRepository: string | null; headRef: string; headSha: string; baseRepository: string | null; baseRef: string; baseSha: string }>();
    const github = {
      appId: deliveryPolicy.appId,
      withContentsWriteToken: async (_installationId:number,_repo:string,action:(token:string)=>Promise<unknown>)=>action("controlled-test-token"),
      createInstallationToken: async () => "controlled-test-token",
      inspectBranch: async (_installationId: number, _repo: string, ref: string) => {
        const result=await exec("git",["--git-dir",remote,"rev-parse","--verify",`refs/heads/${ref}`],{encoding:"utf8",windowsHide:true,timeout:15_000}).catch(()=>null);
        if(!result)return null;const sha=result.stdout.trim();const tree=await exec("git",["--git-dir",remote,"rev-parse",`${sha}^{tree}`],{encoding:"utf8",windowsHide:true,timeout:15_000});return{sha,treeSha:tree.stdout.trim()};
      },
      listCheckRuns: async () => [...checks.values()],
      createDeliveryCheck: async (_installationId: number, _repo: string, headSha: string, name: string, externalId: string) => {
        const value = { id: 17, headSha, name, externalId, conclusion: "success", appId: deliveryPolicy.appId };
        checks.set(value.id, value);
        return value;
      },
      getCheckRun: async (_installationId: number, _repo: string, id: number) => {
        const value = checks.get(id); if (!value) throw new Error("check missing"); return value;
      },
      listPullRequests: async () => [...prs.values()],
      createDraftPullRequest: async (_installationId: number, _repo: string, headRef: string, baseRef: string, _title: string, _body: string) => {
        const value = { number: 23, draft: true, state: "open", merged: false, headRepository: repository, headRef, headSha: candidateSha, baseRepository: repository, baseRef, baseSha };
        prs.set(value.number, value);
        return value;
      },
      getPullRequest: async (_installationId: number, _repo: string, number: number) => {
        const value = prs.get(number); if (!value) throw new Error("pull request missing"); return value;
      },
      createCheckRun: async () => undefined
    } as unknown as GitHubInstallationClient;
    const authority: DeliveryAuthority = {
      integrator,
      reviews: localAuthority.reviews,
      artifacts: { put: async () => { throw new Error("delivery must not create evidence artifacts"); }, get: async (key) => { const bytes = artifacts.get(key); if (!bytes) throw new Error("artifact not found"); return bytes; } },
      github
    };
    const retained = (await store.getMission(mission.id))!.slices.find(row => row.id === "delivery")!.evidenceRefs;
    const unknownRef = `${"unapproved-evidence"}:${workerBundle.key}`;
    await db.query("UPDATE mission_slices SET evidence_refs=$3::jsonb WHERE mission_id=$1 AND id=$2", [mission.id, "delivery", JSON.stringify([...retained, unknownRef])]);
    await assert.rejects(governor.deliverIntegratedCommit(command, deliveryPolicy, authority), /evidence/);
    assert.equal(checks.size, 0, "unknown evidence is rejected before any delivery effect");

    const mismatchDigest = hash("different bytes than stored");
    artifacts.set(`sha256/${mismatchDigest}`, Buffer.from("actual bytes disagree"));
    await db.query("UPDATE mission_slices SET evidence_refs=$3::jsonb WHERE mission_id=$1 AND id=$2", [mission.id, "delivery", JSON.stringify([...retained, `candidate-diff:sha256/${mismatchDigest}`])]);
    await assert.rejects(governor.deliverIntegratedCommit(command, deliveryPolicy, authority), /digest/);
    assert.equal(checks.size, 0, "named evidence digest mismatch is rejected before any delivery effect");
    await db.query("UPDATE mission_slices SET evidence_refs=$3::jsonb WHERE mission_id=$1 AND id=$2", [mission.id, "delivery", JSON.stringify(retained)]);

    const concurrent=await Promise.allSettled([governor.deliverIntegratedCommit(command,deliveryPolicy,authority),governor.deliverIntegratedCommit(command,deliveryPolicy,authority)]);
    assert(concurrent.some(x=>x.status==="fulfilled"));
    const result = await governor.deliverIntegratedCommit(command, deliveryPolicy, authority);
    assert.equal(result.state, "pr_created");
    assert.equal(result.integratedSha, candidateSha);
    assert.equal(checks.size, 1);
    assert.equal(prs.size, 1);
    const remoteHead=await exec("git",["--git-dir",remote,"rev-parse",`refs/heads/${result.branch}`],{encoding:"utf8",windowsHide:true,timeout:15_000});assert.equal(remoteHead.stdout.trim(),candidateSha);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
