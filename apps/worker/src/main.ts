import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createGitHubAppAdapter, createR2ArtifactStore } from "../../../packages/adapters/src/providers.js";
import { PostgresJobStore } from "../../../packages/contracts/src/postgres-store.js";
import { SqlMissionStore } from "../../../packages/contracts/src/sql-mission-store.js";
import { MissionGovernor, TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";
import { canonicalJson } from "../../../packages/judgment/src/canonical.js";
import { DeepSeekHttpClient, R2WorkerProgressSink, type ControlPlane, type WorkerCheckCommand, type WorkerPricingSnapshot } from "../../../packages/agents/src/worker.js";
import type { WorkerExecutionLimits } from "../../../packages/contracts/src/worker-protocol.js";
import { readSecret } from "../../control-plane/src/controller-authority.js";
import { createTrustedVerificationRunner, getCheckPolicy, getCheckAttemptLifetimeMs } from "../../verifier/src/index.js";
import { createControllerAuthorities } from "../../control-plane/src/controller-authority.js";
import { createCertifiedIntegrationPreparer } from "./certified-handoff.js";
import { BareGitFastForwardIntegrator } from "../../../packages/integration/src/local.js";
import type { Config } from "../../../packages/config/src/config.js";
import type { IntegrationRequestV1 } from "../../../packages/contracts/src/mission.js";
import type { DeliveryCommandV1 } from "../../../packages/integration/src/delivery.js";
import type { AdmittingVerificationRunner } from "../../../packages/verification/src/admitting-runner.js";
import { TrustedRuntimeJournalBridge } from "../../control-plane/src/trusted-runtime-journal-bridge.js";
import { runApprovedDockerWorkerLane } from "../../control-plane/src/approved-worker-lane.js";
import { runApprovedWorkerService } from "./approved-service.js";
import { DockerWorkerRuntime } from "./docker-runtime.js";
import { FileRuntimeJournal } from "./runtime-journal.js";
import { acquireWorkerServiceLock } from "./service-lock.js";
import { missingApprovedConfigurationNames, parseApprovedWorkerConfiguration, readApprovedTaskManifest, validateApprovedPricing, type ApprovedTaskManifest } from "./approved-startup.js";

const number = (env: NodeJS.ProcessEnv, name: string, min: number, max: number): number => {
  const raw = env[name]?.trim() ?? "", result = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} is invalid`);
  return result;
};
function jsonValue<T>(env: NodeJS.ProcessEnv, name: string): T {
  try { return JSON.parse(env[name] ?? "") as T; } catch { throw new Error(`${name} is invalid JSON`); }
}
async function privateJson<T>(file: string, name: string): Promise<T> {
  // Policy files are validated by the protected reader in the approved-startup module through the same file policy.
  const { readPrivatePolicyFile } = await import("../../control-plane/src/controller-authority.js");
  const bytes = readPrivatePolicyFile(file, 256_000);
  if (!bytes) throw new Error(`${name} is unavailable or unsafe`);
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw new Error(`${name} is invalid JSON`); }
}
interface ValidatedWorkerPolicies {
  readonly minimumSliceBudgetCents: number;
  readonly checkIds: string[];
  readonly checks: Record<string, WorkerCheckCommand>;
  readonly pricing: WorkerPricingSnapshot;
  readonly integrationRequest?: IntegrationRequestV1;
  readonly deliveryCommand?: DeliveryCommandV1;
}
function checkCommands(value: unknown, ids: string[]): Record<string, WorkerCheckCommand> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ORLOOM_WORKER_CHECK_COMMANDS_FILE is malformed");
  const rows = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(rows).sort()) !== canonicalJson([...ids].sort())) throw new Error("Trusted check commands do not match ORLOOM_TRUSTED_CHECK_POLICY_JSON");
  for (const [id, raw] of Object.entries(rows)) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Trusted check command entry is invalid");
    const command = raw as WorkerCheckCommand;
    if (typeof command.executable !== "string" || !/^(node|npm|pnpm|python3|pytest|ruff|go|cargo)$/.test(command.executable.split(/[\\/]/).at(-1) ?? "") || !Array.isArray(command.args) || command.args.length > 64 || command.args.some(arg => typeof arg !== "string" || arg.length > 500) || !Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 300) throw new Error("Trusted check command entry is invalid");
  }
  return rows as Record<string, WorkerCheckCommand>;
}
function validateTaskAgainstConfiguration(task: ApprovedTaskManifest, env: NodeJS.ProcessEnv): void {
  if (env.ORLOOM_WORKER_SANDBOX_IMAGE_REF !== task.workerImageRef || env.ORLOOM_VERIFIER_IMAGE !== task.verifierImageRef) throw new Error("Configured worker and verifier images do not match the approved manifest");
  number(env, "ORLOOM_GITHUB_APP_ID", 1, Number.MAX_SAFE_INTEGER); number(env, "ORLOOM_GITHUB_INSTALLATION_ID", 1, Number.MAX_SAFE_INTEGER);
  if (!/^[a-f0-9]{32}$/i.test(env.ORLOOM_R2_ACCOUNT_ID ?? "") || !/^[A-Za-z0-9._-]{3,63}$/.test(env.ORLOOM_R2_BUCKET ?? "")) throw new Error("R2 account or bucket configuration is invalid");
  if (env.ORLOOM_CAPACITY_EVIDENCE_VERIFIED !== "true" || !/^[a-f0-9]{64}$/.test(env.ORLOOM_CAPACITY_EVIDENCE_SHA256 ?? "")) throw new Error("Capacity evidence is not verified");
  const ids = jsonValue<unknown>(env, "ORLOOM_TRUSTED_CHECK_POLICY_JSON");
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0].trim() || createHash("sha256").update(JSON.stringify(ids)).digest("hex") !== task.trustedCheckPolicyDigest) throw new Error("Trusted check policy does not match the approved manifest");
  const providers = jsonValue<unknown>(env, "ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON"), models = jsonValue<unknown>(env, "ORLOOM_WORKER_ALLOWED_MODELS_JSON");
  if (!Array.isArray(providers) || providers.length !== 1 || providers[0] !== "deepseek" || !Array.isArray(models) || models.length !== 1 || models.some(x => typeof x !== "string" || !x.trim())) throw new Error("Worker provider/model allowlists must be explicit and singular");
  if (!/^[0-9a-f]{64}$/i.test(env.ORLOOM_CAPACITY_EVIDENCE_SHA256 ?? "") || !Number.isFinite(Date.parse(env.ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT ?? "")) || Date.parse(env.ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT!) <= Date.now()) throw new Error("Capacity evidence is invalid or expired");
  const checkId = env.ORLOOM_VERIFIER_CHECK_ID;
  if (!checkId || !ids.includes(checkId)) throw new Error("Verifier check ID is outside the trusted policy");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(env.ORLOOM_VERIFIER_ID ?? "")) throw new Error("ORLOOM_VERIFIER_ID is invalid");
  const verifierDigest = task.verifierImageRef.match(/sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  const checkPolicy = getCheckPolicy(checkId, task.verifierImageRef, verifierDigest);
  if (checkPolicy.version !== env.ORLOOM_VERIFICATION_POLICY_VERSION) throw new Error("ORLOOM_VERIFICATION_POLICY_VERSION does not match the fixed verifier policy");
  number(env, "ORLOOM_WORKER_MAX_PROVIDER_CALLS", 1, 64); number(env, "ORLOOM_WORKER_MAX_INPUT_TOKENS", 1, 1_000_000);
  number(env, "ORLOOM_WORKER_MAX_OUTPUT_TOKENS", 1, 100_000); number(env, "ORLOOM_WORKER_MAX_WALL_SECONDS", 1, 3600);
  number(env, "ORLOOM_WORKER_MAX_TOOL_CALLS", 1, 256); number(env, "ORLOOM_MAX_LANES", 1, 6);
  if (number(env, "ORLOOM_CAPACITY_SLOTS", 1, 1) !== 1 || number(env, "ORLOOM_MAX_LANES", 1, 1) !== 1) throw new Error("Approved single-slice startup requires exactly one lane and capacity slot");
}
async function validatePolicyFiles(env: NodeJS.ProcessEnv, task: ApprovedTaskManifest): Promise<ValidatedWorkerPolicies> {
  const ids = jsonValue<string[]>(env, "ORLOOM_TRUSTED_CHECK_POLICY_JSON");
  const checks = checkCommands(await privateJson(env.ORLOOM_WORKER_CHECK_COMMANDS_FILE!, "ORLOOM_WORKER_CHECK_COMMANDS_FILE"), ids);
  const pricing = await privateJson<WorkerPricingSnapshot>(env.ORLOOM_WORKER_PRICING_SNAPSHOT_FILE!, "ORLOOM_WORKER_PRICING_SNAPSHOT_FILE");
  const models = jsonValue<string[]>(env, "ORLOOM_WORKER_ALLOWED_MODELS_JSON");
  if (!pricing || typeof pricing !== "object" || typeof pricing.model !== "string" || !models.includes(pricing.model) || pricing.model !== models[0]) throw new Error("Worker pricing snapshot model is outside the approved model list");
  const worstCaseCost = validateApprovedPricing(pricing, { maxInputTokens: number(env, "ORLOOM_WORKER_MAX_INPUT_TOKENS", 1, 1_000_000), maxOutputTokens: number(env, "ORLOOM_WORKER_MAX_OUTPUT_TOKENS", 1, 100_000) }, task.maxBudgetCents);
  const repositories = jsonValue<Record<string, unknown>>(env, "ORLOOM_VERIFIER_REPOSITORIES");
  if (!repositories || typeof repositories !== "object" || Array.isArray(repositories) || !Object.hasOwn(repositories, task.repository)) throw new Error("Trusted verifier repository map does not include the approved repository");
  const artifactRoot = env.ORLOOM_VERIFIER_ARTIFACT_ROOT!, admissionRoot = env.ORLOOM_CANDIDATE_ADMISSION_ROOT!;
  for (const [name, value] of [["ORLOOM_VERIFIER_ARTIFACT_ROOT", artifactRoot], ["ORLOOM_CANDIDATE_ADMISSION_ROOT", admissionRoot]] as const) {
    if (!path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || value.split(path.sep).some(part => ["tmp", "temp"].includes(part.toLowerCase())) || isInside(process.cwd(), value) || isInside(value, process.cwd())) throw new Error(`${name} must be a persistent absolute path outside the source worktree`);
  }
  if (isInside(artifactRoot, admissionRoot) || isInside(admissionRoot, artifactRoot)) throw new Error("Verifier artifact and candidate admission roots must be separate");
  for (const [repository, raw] of Object.entries(repositories)) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ORLOOM_VERIFIER_REPOSITORIES entry is invalid");
    const config = raw as Record<string, unknown>;
    if (typeof config.objectStore !== "string" || !path.isAbsolute(config.objectStore) || typeof config.approvedRef !== "string" || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(config.approvedRef) || config.approvedRef.includes("..")) throw new Error("ORLOOM_VERIFIER_REPOSITORIES entry is invalid");
    for (const root of [artifactRoot, admissionRoot, process.cwd()]) if (isInside(root, config.objectStore) || isInside(config.objectStore, root)) throw new Error("Verifier object stores must be separate from worker source and artifact roots");
  }
  const integration = configuredBool(env, "ORLOOM_INTEGRATION_ENABLED"), delivery = configuredBool(env, "ORLOOM_DELIVERY_ENABLED");
  const requestFile = env.ORLOOM_WORKER_INTEGRATION_REQUEST_FILE?.trim(), commandFile = env.ORLOOM_WORKER_DELIVERY_COMMAND_FILE?.trim();
  let integrationRequest: IntegrationRequestV1 | undefined, deliveryCommand: DeliveryCommandV1 | undefined;
  if (delivery && !integration) throw new Error("ORLOOM_DELIVERY_ENABLED requires ORLOOM_INTEGRATION_ENABLED");
  if ((requestFile || commandFile) && !integration) throw new Error("Explicit review or delivery request files require ORLOOM_INTEGRATION_ENABLED");
  if (integration) {
    for (const name of ["ORLOOM_INTEGRATION_REPOSITORY", "ORLOOM_INTEGRATION_BARE_REPOSITORY", "ORLOOM_REVIEW_ARTIFACT_ROOT"]) {
      const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required when integration is enabled`);
      if (name !== "ORLOOM_INTEGRATION_REPOSITORY" && (!path.isAbsolute(value) || path.resolve(value) !== value)) throw new Error(`${name} must be absolute and normalized`);
    }
    if (env.ORLOOM_INTEGRATION_REPOSITORY !== task.repository) throw new Error("ORLOOM_INTEGRATION_REPOSITORY must match the approved repository");
    if (requestFile) integrationRequest = await privateJson<IntegrationRequestV1>(requestFile, "ORLOOM_WORKER_INTEGRATION_REQUEST_FILE");
    if (delivery) {
      if (!env.ORLOOM_DELIVERY_POLICY_FILE?.trim() || !commandFile) throw new Error("Delivery requires ORLOOM_DELIVERY_POLICY_FILE and ORLOOM_WORKER_DELIVERY_COMMAND_FILE");
      deliveryCommand = await privateJson<DeliveryCommandV1>(commandFile, "ORLOOM_WORKER_DELIVERY_COMMAND_FILE");
      const deliveryPolicyFile = env.ORLOOM_DELIVERY_POLICY_FILE.trim();
      if (!path.isAbsolute(deliveryPolicyFile) || path.resolve(deliveryPolicyFile) !== deliveryPolicyFile) throw new Error("ORLOOM_DELIVERY_POLICY_FILE must be absolute and normalized");
      await privateJson<Record<string, unknown>>(deliveryPolicyFile, "ORLOOM_DELIVERY_POLICY_FILE");
      if (!requestFile) throw new Error("ORLOOM_WORKER_INTEGRATION_REQUEST_FILE is required for delivery");
    }
  }
  return { minimumSliceBudgetCents: worstCaseCost, checkIds: ids, checks, pricing, ...(integrationRequest ? { integrationRequest } : {}), ...(deliveryCommand ? { deliveryCommand } : {}) };
}
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function configuredBool(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}
async function validateProtectedPaths(env: NodeJS.ProcessEnv): Promise<void> {
  const root = env.ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT!, lock = env.ORLOOM_WORKER_SERVICE_LOCK_FILE!;
  for (const [name, value] of [["ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT", root], ["ORLOOM_WORKER_SERVICE_LOCK_FILE", lock]] as const) {
    if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new Error(`${name} must be absolute and normalized`);
  }
  const rootInfo = await lstat(root).catch(() => null), rootReal = await realpath(root).catch(() => "");
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || rootReal !== path.resolve(root) || (process.platform === "linux" && (rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077) !== 0))) throw new Error("ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT must be a private owned real directory");
  const parentInfo = await lstat(path.dirname(lock)).catch(() => null), lockInfo = await lstat(lock).catch(() => null), lockReal = await realpath(lock).catch(() => "");
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink() || !lockInfo?.isFile() || lockInfo.isSymbolicLink() || lockReal !== path.resolve(lock)
    || (process.platform === "linux" && (parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022) !== 0 || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o077) !== 0))) throw new Error("ORLOOM_WORKER_SERVICE_LOCK_FILE must be private, owned, regular, and in a protected directory");
}
function preflightImage(ref: string): void {
  const result = spawnSync("/usr/bin/docker", ["image", "inspect", "--format", "{{.Id}} {{json .RepoDigests}}", ref], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" } });
  if (result.error || result.status !== 0) throw new Error("A pinned approved image is not preloaded in the Docker daemon");
  const digest = ref.match(/sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!digest || !result.stdout.toLowerCase().includes(digest)) throw new Error("Preloaded Docker image digest does not match the approved reference");
}

async function runApproved(task: ApprovedTaskManifest, env: NodeJS.ProcessEnv, signal: AbortSignal, policies: ValidatedWorkerPolicies): Promise<string> {
  // All shape, policy, and pointer validation completes before any secret is read.
  validateTaskAgainstConfiguration(task, env);
  const githubAppId = number(env, "ORLOOM_GITHUB_APP_ID", 1, Number.MAX_SAFE_INTEGER);
  const githubPrivateKey = readSecret(env, "ORLOOM_GITHUB_PRIVATE_KEY");
  const accountId = env.ORLOOM_R2_ACCOUNT_ID?.trim(), bucket = env.ORLOOM_R2_BUCKET?.trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") || !bucket) throw new Error("R2 adapter configuration is invalid");
  const accessKeyId = readSecret(env, "ORLOOM_R2_ACCESS_KEY_ID"), secretAccessKey = readSecret(env, "ORLOOM_R2_SECRET_ACCESS_KEY");
  const databaseUrl = readSecret(env, "ORLOOM_DATABASE_URL");
  const deepseekKey = readSecret(env, "ORLOOM_DEEPSEEK_API_KEY");
  if (!githubPrivateKey || !accessKeyId || !secretAccessKey || !databaseUrl || !deepseekKey) throw new Error("Approved worker credentials are incomplete");
  const installationId = number(env, "ORLOOM_GITHUB_INSTALLATION_ID", 1, Number.MAX_SAFE_INTEGER);
  const workerImageRef = task.workerImageRef;
  const minimumSliceBudgetCents = policies.minimumSliceBudgetCents;
  const checkIds = policies.checkIds, checks = policies.checks, pricing = policies.pricing;
  const github = createGitHubAppAdapter({ appId: githubAppId, privateKey: githubPrivateKey });
  const artifacts = createR2ArtifactStore({ accountId: accountId!, accessKeyId, secretAccessKey, bucket: bucket! });
  let lock: Awaited<ReturnType<typeof acquireWorkerServiceLock>> | undefined;
  let jobStore: PostgresJobStore | undefined;
  try {
    lock = await acquireWorkerServiceLock(env.ORLOOM_WORKER_SERVICE_LOCK_FILE!);
    preflightImage(workerImageRef); preflightImage(task.verifierImageRef);
    const connected = await PostgresJobStore.connect(databaseUrl);
    jobStore = connected;
    const store = new SqlMissionStore(connected);
    const capacityExpires = env.ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT!;
    await store.configureCapacity(1, env.ORLOOM_CAPACITY_EVIDENCE_SHA256!, capacityExpires);
    const policyIds = checkIds;
    const governor = new MissionGovernor(store, {
      maxLanes: 1, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: task.trustedCheckPolicyDigest,
      trustedCheckPolicy: policyIds, executionConfigured: true,
      progressLimits: { maxProviderCalls: number(env, "ORLOOM_WORKER_MAX_PROVIDER_CALLS", 1, 64), maxInputTokens: number(env, "ORLOOM_WORKER_MAX_INPUT_TOKENS", 1, 1_000_000), maxOutputTokens: number(env, "ORLOOM_WORKER_MAX_OUTPUT_TOKENS", 1, 100_000), maxWallSeconds: number(env, "ORLOOM_WORKER_MAX_WALL_SECONDS", 1, 3600) }
    });
    const runner = await createTrustedVerificationRunner(env);
    if (!runner) throw new Error("Trusted verification configuration is not enabled");
    const verifierDigest = task.verifierImageRef.match(/sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    const policy = getCheckPolicy(env.ORLOOM_VERIFIER_CHECK_ID!, task.verifierImageRef, verifierDigest);
    if (!policyIds.includes(policy.id)) throw new Error("Verifier policy is outside the configured approved policy");
    const trustedChecks = new TrustedCheckCoordinator(store, runner, { imageDigest: policy.imageDigest, verifierId: env.ORLOOM_VERIFIER_ID!, policyDigest: policy.digest, leasePolicyDigest: task.trustedCheckPolicyDigest, policyVersion: policy.version, allowedChecks: [policy.id], attemptLifetimeMs: getCheckAttemptLifetimeMs(policy.id) });
    const integrationEnabled = configuredBool(env, "ORLOOM_INTEGRATION_ENABLED"), deliveryEnabled = configuredBool(env, "ORLOOM_DELIVERY_ENABLED");
    const integrationRequest = policies.integrationRequest, deliveryCommand = policies.deliveryCommand;
    let integrationAuthority: Awaited<ReturnType<typeof createControllerAuthorities>>["localIntegration"];
    let deliveryController: Awaited<ReturnType<typeof createControllerAuthorities>>["deliveryController"];
    if (integrationEnabled) {
      const config: Config = {
        mode: "cloud", port: 3000, sessionToken: "", databaseUrl, maxLanes: 1, capacitySlots: 1,
        capacityEvidenceDigest: env.ORLOOM_CAPACITY_EVIDENCE_SHA256 ?? null, capacityEvidenceExpiresAt: env.ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT ?? null,
        trustedCheckPolicy: checkIds, trustedCheckPolicyDigest: task.trustedCheckPolicyDigest,
        trustedVerifierId: env.ORLOOM_VERIFIER_ID ?? null, trustedVerifierImageDigest: policy.imageDigest, trustedVerificationPolicyVersion: policy.version,
        integrationEnabled: true, integrationRepository: env.ORLOOM_INTEGRATION_REPOSITORY!.trim(), integrationBareRepository: env.ORLOOM_INTEGRATION_BARE_REPOSITORY!.trim(),
        reviewArtifactRoot: env.ORLOOM_REVIEW_ARTIFACT_ROOT!.trim(), deliveryEnabled, ...(deliveryEnabled ? { deliveryPolicyFile: env.ORLOOM_DELIVERY_POLICY_FILE!.trim() } : {})
      };
      const authorities = await createControllerAuthorities(config, { checkId: policy.id, policy, coordinator: trustedChecks }, env);
      integrationAuthority = authorities.localIntegration; deliveryController = authorities.deliveryController;
    }
    let prepareCertifiedIntegration: ((record: NonNullable<Awaited<ReturnType<SqlMissionStore["getMission"]>>>, request: IntegrationRequestV1) => Promise<void>) | undefined;
    if (integrationEnabled && integrationRequest) {
      if (typeof (runner as { admitForController?: unknown }).admitForController !== "function" || !integrationAuthority?.integrator) throw new Error("Certified integration requires the trusted admission runner and local integration authority");
      prepareCertifiedIntegration = createCertifiedIntegrationPreparer({
        store, coordinator: trustedChecks, admittingRunner: runner as AdmittingVerificationRunner,
        integrator: integrationAuthority.integrator as BareGitFastForwardIntegrator, reviews: integrationAuthority.reviews, artifacts
      });
    }
    const journal = await FileRuntimeJournal.openOperational(env.ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT!);
    const runtimeBridge = new TrustedRuntimeJournalBridge(journal, store);
    const runtime = new DockerWorkerRuntime({ imageRef: workerImageRef, installationId, checkoutTokens: github, checks, runtimeJournal: runtimeBridge });
    const control: ControlPlane = {
      async claim() { return null; },
      async cancellationRequested(lease) { return Boolean(await store.cancellationStatus?.(lease.mission.id, lease.slice.id, lease.leaseEpoch, lease.leaseToken, lease.capabilityToken)); },
      async heartbeat(lease) { await governor.heartbeat(lease.mission.id, lease.slice.id, lease.leaseEpoch, lease.leaseToken, lease.capabilityToken); },
      async result(lease, result) {
        if ("candidateSha" in result) await governor.complete(lease.mission.id, lease.slice.id, lease.leaseEpoch, lease.leaseToken, lease.capabilityToken, result.candidateSha, result.evidenceRefs);
        else await governor.reportOutcome(lease.mission.id, lease.slice.id, lease.leaseEpoch, lease.leaseToken, lease.capabilityToken, result.outcome, result.reasonCode, result.evidenceRefs);
      }
    };
    const limits: WorkerExecutionLimits = { reservedBudgetCents: task.maxBudgetCents, maxProviderCalls: number(env, "ORLOOM_WORKER_MAX_PROVIDER_CALLS", 1, 64), maxInputTokens: number(env, "ORLOOM_WORKER_MAX_INPUT_TOKENS", 1, 1_000_000), maxOutputTokens: number(env, "ORLOOM_WORKER_MAX_OUTPUT_TOKENS", 1, 100_000), maxWallSeconds: number(env, "ORLOOM_WORKER_MAX_WALL_SECONDS", 1, 3600), allowedProviders: jsonValue<string[]>(env, "ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON"), allowedModels: jsonValue<string[]>(env, "ORLOOM_WORKER_ALLOWED_MODELS_JSON") };
    const provider = new DeepSeekHttpClient(deepseekKey);
    const serviceResult = await runApprovedWorkerService({ task, executionLimits: limits, minimumSliceBudgetCents, leaseSeconds: 300, signal, ...(integrationRequest ? { integrationRequest } : {}), ...(deliveryCommand ? { deliveryCommand } : {}) }, {
      governor, store, trustedChecks,
      reconcileInterrupted: async target => runtime.reconcileInterrupted(target),
      reconcileRetained: async target => {
        const reconciled = await runtimeBridge.reconcileRetained(undefined, target);
        if (reconciled.includes("quarantined")) throw new Error("Retained runtime settlement remains quarantined");
      },
      ...(integrationAuthority ? { integrationAuthority } : {}), ...(prepareCertifiedIntegration ? { prepareCertifiedIntegration } : {}),
      ...(deliveryController ? { deliveryPolicy: deliveryController.policy, deliveryAuthority: deliveryController.authority } : {}),
      executeLane: async (lease, _binding, laneSignal) => runApprovedDockerWorkerLane(lease, {
        store, binding: { missionId: task.missionId, slice: { id: lease.slice.id, objective: lease.slice.objective, dependencies: lease.slice.dependencies, owner: lease.slice.owner, scopes: lease.slice.scopes, checks: lease.slice.checks, budgetCents: lease.executionLimits.reservedBudgetCents }, baseSha: task.baseSha, planDigest: task.planDigest, trustedCheckPolicyDigest: task.trustedCheckPolicyDigest },
        control, provider, evidence: artifacts, progress: new R2WorkerProgressSink(artifacts), checks: Object.fromEntries(checkIds.map(id => [id, [id]])), options: { allowedModels: limits.allowedModels, allowedProviders: limits.allowedProviders, trustedChecks: checkIds, trustedCheckPolicyDigest: task.trustedCheckPolicyDigest, trustedCheckCommands: checks, sandboxImageRef: workerImageRef, maxToolCalls: number(env, "ORLOOM_WORKER_MAX_TOOL_CALLS", 1, 256), pricing: pricing as never }, trustedChecks, runtimeJournal: runtimeBridge,
        runtimeOptions: { imageRef: workerImageRef, installationId, checkoutTokens: github, checks }, signal: laneSignal
      })
    });
    return serviceResult;
  } finally {
    try { if (jobStore) await jobStore.close(); }
    finally { if (lock) await lock.release(); }
  }
}

async function main(): Promise<void> {
  try {
    const config = parseApprovedWorkerConfiguration(process.env);
    if (config.mode === "disabled") {
      process.stderr.write("Orloom worker composition is disabled: independent candidate admission and cancellation reconciliation are not configured.\n");
      process.exitCode = 1; return;
    }
    const task = await readApprovedTaskManifest(config.taskFile);
    const missing = missingApprovedConfigurationNames(process.env);
    if (missing.length) throw new Error(`Approved worker configuration is incomplete: ${missing.join(", ")}`);
    validateTaskAgainstConfiguration(task, process.env);
    const policies = await validatePolicyFiles(process.env, task);
    await validateProtectedPaths(process.env);
    if (process.argv.includes("--check-config")) { process.stdout.write("Approved worker config valid; secret contents were not read.\n"); return; }
    if (process.platform !== "linux") throw new Error("Approved worker production service requires Linux");
    const shutdown = new AbortController();
    const onTerm = () => shutdown.abort(new Error("worker service shutdown requested"));
    process.once("SIGTERM", onTerm); process.once("SIGINT", onTerm);
    const expiryTimer = setTimeout(onTerm, Math.max(0, Date.parse(task.expiresAt) - Date.now())); expiryTimer.unref();
    try {
      const result = await runApproved(task, process.env, shutdown.signal, policies);
      process.stdout.write(`Approved worker task ${task.missionId}/${task.sliceId} finished: ${result}.\n`);
    } catch {
      process.stderr.write(`Orloom approved worker task ${task.missionId}/${task.sliceId} failed; details suppressed.\n`);
      process.exitCode = 1;
    } finally {
      clearTimeout(expiryTimer);
      process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onTerm);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid worker configuration";
    process.stderr.write(`Orloom approved worker startup blocked: ${message}.\n`);
    process.exitCode = 1;
  }
}

void main();
