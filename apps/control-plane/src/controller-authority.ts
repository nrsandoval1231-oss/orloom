import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { createR2ArtifactStore, createGitHubAppAdapter } from "../../../packages/adapters/src/providers.js";
import type { Config } from "../../../packages/config/src/config.js";
import { BareGitFastForwardIntegrator } from "../../../packages/integration/src/local.js";
import type { DeliveryAuthority, DeliveryPolicy } from "../../../packages/integration/src/delivery.js";
import type { CheckPolicy } from "../../../packages/verification/src/policy.js";
import type { LocalIntegrationAuthority, TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";

const maxReviewBytes = 256 * 1024;
const policyKeys = ["repository", "appId", "installationId", "baseRef", "baseSha", "protectedRefs", "checkIds", "policyVersion", "policyDigest", "imageDigest", "checkName"] as const;
const validRepository = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value);
const validRef = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("/") && !value.includes("..") && !value.endsWith("/");
const sha1 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function assertPrivateStat(info: Awaited<ReturnType<typeof lstat>>, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("not a regular private file");
  if (process.platform !== "win32") {
    if ((Number(info.mode) & 0o077) !== 0) throw new Error("permissions are not private");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("owner mismatch");
  }
}

async function readPrivateFile(file: string, limit: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file);
    assertPrivateStat(before, false);
    if (before.size > limit) return null;
    const resolved = await realpath(file);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(file, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(8192, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await lstat(file);
    assertPrivateStat(after, false);
    if (after.dev !== opened.dev || after.ino !== opened.ino || await realpath(file) !== resolved) return null;
    return Buffer.concat(chunks, total);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function createReviewArtifactReader(configuredRoot: string) {
  const rootBefore = await lstat(configuredRoot).catch(() => null);
  if (!rootBefore) throw new Error("ORLOOM_REVIEW_ARTIFACT_ROOT is unavailable");
  try { assertPrivateStat(rootBefore, true); } catch { throw new Error("ORLOOM_REVIEW_ARTIFACT_ROOT must be a private real directory"); }
  const root = await realpath(configuredRoot).catch(() => "");
  if (!root || !path.isAbsolute(root)) throw new Error("ORLOOM_REVIEW_ARTIFACT_ROOT is unavailable");
  return {
    async read(artifactId: string): Promise<Buffer | null> {
      if (typeof artifactId !== "string" || !/^[A-Za-z0-9._-]{1,180}$/.test(artifactId) || artifactId === "." || artifactId === "..") return null;
      const currentRoot = await lstat(configuredRoot).catch(() => null);
      if (!currentRoot) return null;
      try { assertPrivateStat(currentRoot, true); } catch { return null; }
      if (await realpath(configuredRoot).catch(() => "") !== root) return null;
      const file = path.join(root, `${artifactId}.json`);
      const resolved = await realpath(file).catch(() => "");
      if (!resolved || path.dirname(resolved) !== root) return null;
      return readPrivateFile(file, maxReviewBytes);
    }
  };
}

function readSecret(env: NodeJS.ProcessEnv, name: string, maxBytes = 8192): string | undefined {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    if (!path.isAbsolute(file)) throw new Error(`${name}_FILE must be an absolute private file path`);
    const bytes = readPrivateFileSync(file, maxBytes);
    if (!bytes?.length) throw new Error(`${name}_FILE is missing, unreadable, or empty`);
    return bytes.toString("utf8").trim();
  }
  const value = env[name];
  if (value && Buffer.byteLength(value, "utf8") <= maxBytes) return value.trim();
  return undefined;
}

function readPrivateFileSync(file: string, limit: number): Buffer | null {
  // Secrets and policy are read only during startup; keep errors field-only and byte-bounded.
  try {
    const before = lstatSync(file);
    assertPrivateStat(before, false);
    if (before.size > limit) return null;
    const resolved = realpathSync(file);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= limit) {
        const chunk = Buffer.alloc(Math.min(8192, limit + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (!count) break;
        total += count;
        if (total > limit) return null;
        chunks.push(chunk.subarray(0, count));
      }
      const after = lstatSync(file);
      assertPrivateStat(after, false);
      return after.dev === opened.dev && after.ino === opened.ino && realpathSync(file) === resolved ? Buffer.concat(chunks, total) : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

function parseDeliveryPolicy(bytes: Buffer, config: Config, checkPolicy: CheckPolicy, appId: number): DeliveryPolicy {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("ORLOOM_DELIVERY_POLICY_FILE is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ORLOOM_DELIVERY_POLICY_FILE must contain an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== policyKeys.length || policyKeys.some(key => !Object.hasOwn(record, key))) throw new Error("ORLOOM_DELIVERY_POLICY_FILE has missing or unknown fields");
  const protectedRefs = record.protectedRefs;
  const checkIds = record.checkIds;
  if (!validRepository(record.repository) || record.repository !== config.integrationRepository || record.appId !== appId || !Number.isSafeInteger(record.installationId) || (record.installationId as number) < 1 || !validRef(record.baseRef) || !sha1(record.baseSha)
    || !Array.isArray(protectedRefs) || protectedRefs.length > 64 || protectedRefs.some(ref => !validRef(ref)) || new Set(protectedRefs).size !== protectedRefs.length || !protectedRefs.includes(record.baseRef)
    || !Array.isArray(checkIds) || checkIds.length !== 1 || checkIds[0] !== "node-repo-suite-v1" || record.policyVersion !== checkPolicy.version || record.policyDigest !== checkPolicy.digest || record.imageDigest !== checkPolicy.imageDigest
    || typeof record.checkName !== "string" || !record.checkName.trim() || record.checkName.length > 100) throw new Error("ORLOOM_DELIVERY_POLICY_FILE does not match the fixed repository and trusted full-suite policy");
  return Object.freeze({
    repository: record.repository,
    appId: record.appId as number,
    installationId: record.installationId as number,
    baseRef: record.baseRef,
    baseSha: record.baseSha,
    protectedRefs: Object.freeze([...protectedRefs]) as unknown as string[],
    checkIds: Object.freeze([...checkIds]) as unknown as string[],
    policyVersion: record.policyVersion as string,
    policyDigest: record.policyDigest as string,
    imageDigest: record.imageDigest as string,
    checkName: record.checkName
  });
}

export interface ControllerTrustedBinding {
  checkId?: string;
  policy?: CheckPolicy;
  coordinator?: TrustedCheckCoordinator;
}
export interface ControllerAuthorities {
  localIntegration?: LocalIntegrationAuthority;
  deliveryController?: { policy: DeliveryPolicy; authority: DeliveryAuthority };
}

export async function createControllerAuthorities(config: Config, trusted: ControllerTrustedBinding, env: NodeJS.ProcessEnv = process.env): Promise<ControllerAuthorities> {
  if (!config.integrationEnabled && !config.deliveryEnabled) return {};
  if (config.mode !== "cloud" || !config.integrationEnabled || !config.integrationRepository || !config.integrationBareRepository || !config.reviewArtifactRoot) throw new Error("Controller integration configuration is incomplete");
  if (!trusted.coordinator || trusted.checkId !== "node-repo-suite-v1" || !trusted.policy || !config.trustedCheckPolicy?.includes("node-repo-suite-v1") || trusted.policy.id !== "node-repo-suite-v1" || (config.trustedVerificationPolicyVersion && config.trustedVerificationPolicyVersion !== trusted.policy.version)) throw new Error("Controller integration requires the configured trusted node-repo-suite-v1 verifier");
  const integrator = await BareGitFastForwardIntegrator.open(config.integrationBareRepository, config.integrationRepository);
  if (integrator.repositoryIdentity !== config.integrationRepository) throw new Error("ORLOOM_INTEGRATION_REPOSITORY does not match the fixed local repository identity");
  const reviews = await createReviewArtifactReader(config.reviewArtifactRoot);
  const localIntegration = Object.freeze({ integrator, reviews });
  if (!config.deliveryEnabled) return { localIntegration };
  if (!config.deliveryPolicyFile) throw new Error("ORLOOM_DELIVERY_POLICY_FILE is required");

  const appIdRaw = env.ORLOOM_GITHUB_APP_ID?.trim();
  const appId = appIdRaw && /^\d+$/.test(appIdRaw) ? Number(appIdRaw) : NaN;
  const privateKey = readSecret(env, "ORLOOM_GITHUB_PRIVATE_KEY");
  const accountId = env.ORLOOM_R2_ACCOUNT_ID?.trim();
  const accessKeyId = readSecret(env, "ORLOOM_R2_ACCESS_KEY_ID");
  const secretAccessKey = readSecret(env, "ORLOOM_R2_SECRET_ACCESS_KEY");
  const bucket = env.ORLOOM_R2_BUCKET?.trim();
  if (!Number.isSafeInteger(appId) || appId < 1 || !privateKey || !/^[a-f0-9]{32}$/i.test(accountId ?? "") || !accessKeyId || !secretAccessKey || !bucket || !/^[A-Za-z0-9._-]{3,63}$/.test(bucket)) throw new Error("Delivery requires ORLOOM_GITHUB_APP_ID, ORLOOM_GITHUB_PRIVATE_KEY[_FILE], and valid R2 account, key, secret, and bucket fields");
  const policyBytes = readPrivateFileSync(config.deliveryPolicyFile, 16 * 1024);
  if (!policyBytes) throw new Error("ORLOOM_DELIVERY_POLICY_FILE is unavailable, unsafe, or oversized");
  const policy = parseDeliveryPolicy(policyBytes, config, trusted.policy, appId);
  let artifacts: DeliveryAuthority["artifacts"];
  try { artifacts = createR2ArtifactStore({ accountId: accountId!, accessKeyId, secretAccessKey, bucket }); }
  catch { throw new Error("R2 artifact adapter configuration is invalid"); }
  let github: DeliveryAuthority["github"];
  try { github = createGitHubAppAdapter({ appId, privateKey }); }
  catch { throw new Error("ORLOOM_GITHUB_APP_ID or ORLOOM_GITHUB_PRIVATE_KEY[_FILE] is invalid"); }
  return { localIntegration, deliveryController: { policy, authority: Object.freeze({ integrator, reviews, artifacts, github }) } };
}
