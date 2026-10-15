import path from "node:path";
import { readPrivatePolicyFile } from "../../control-plane/src/controller-authority.js";

export interface ApprovedTaskManifest {
  version: "orloom.approved-worker-task.v1";
  missionId: string;
  sliceId: string;
  repository: string;
  baseSha: string;
  planDigest: string;
  trustedCheckPolicyDigest: string;
  maxBudgetCents: number;
  expiresAt: string;
  workerImageRef: string;
  verifierImageRef: string;
}
export interface ApprovedPricingLimits {
  model: string; version: string; source: string; capturedAt: string; expiresAt: string;
  inputCentsPerMillion: number; outputCentsPerMillion: number; reasoningCentsPerMillion: number; safetyMultiplier: number;
}
export type ApprovedWorkerConfiguration = { mode: "disabled" } | { mode: "approved-single"; taskFile: string };
const manifestKeys = ["version", "missionId", "sliceId", "repository", "baseSha", "planDigest", "trustedCheckPolicyDigest", "maxBudgetCents", "expiresAt", "workerImageRef", "verifierImageRef"] as const;
const digest = /^[a-f0-9]{64}$/;
const imageRef = /^(?:sha256:|.+@sha256:)[a-f0-9]{64}$/i;

export function parseApprovedWorkerConfiguration(env: NodeJS.ProcessEnv): ApprovedWorkerConfiguration {
  const mode = env.ORLOOM_WORKER_MODE?.trim();
  if (!mode) {
    if (env.ORLOOM_WORKER_APPROVED_TASK_FILE?.trim()) throw new Error("ORLOOM_WORKER_MODE=approved-single is required when an approved task file is configured");
    return { mode: "disabled" };
  }
  if (mode !== "approved-single") throw new Error("ORLOOM_WORKER_MODE must be approved-single");
  const taskFile = env.ORLOOM_WORKER_APPROVED_TASK_FILE?.trim();
  if (!taskFile) throw new Error("ORLOOM_WORKER_APPROVED_TASK_FILE is required");
  if (!path.isAbsolute(taskFile) || path.resolve(taskFile) !== taskFile) throw new Error("ORLOOM_WORKER_APPROVED_TASK_FILE must be an absolute normalized path");
  return { mode, taskFile };
}

export async function readApprovedTaskManifest(file: string, now = Date.now()): Promise<ApprovedTaskManifest> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error("Approved task manifest path must be absolute and normalized");
  const bytes = readPrivatePolicyFile(file, 16 * 1024);
  if (!bytes) throw new Error("Approved task manifest must be a private, owned regular file under 16 KiB");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Approved task manifest is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Approved task manifest must be an object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== manifestKeys.length || manifestKeys.some(key => !Object.hasOwn(row, key))) throw new Error("Approved task manifest has missing or unknown fields");
  if (row.version !== "orloom.approved-worker-task.v1" || typeof row.missionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.missionId)
    || typeof row.sliceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.sliceId)
    || typeof row.repository !== "string" || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(row.repository)
    || typeof row.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(row.baseSha)
    || typeof row.planDigest !== "string" || !digest.test(row.planDigest)
    || typeof row.trustedCheckPolicyDigest !== "string" || !digest.test(row.trustedCheckPolicyDigest)
    || !Number.isSafeInteger(row.maxBudgetCents) || (row.maxBudgetCents as number) < 1 || (row.maxBudgetCents as number) > 100_000
    || typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now
    || typeof row.workerImageRef !== "string" || !imageRef.test(row.workerImageRef)
    || typeof row.verifierImageRef !== "string" || !imageRef.test(row.verifierImageRef)) throw new Error("Approved task manifest fields are invalid or expired");
  return Object.freeze({ ...row }) as unknown as ApprovedTaskManifest;
}

export function validateApprovedPricing(pricing: ApprovedPricingLimits, limits: { maxInputTokens: number; maxOutputTokens: number }, maxBudgetCents: number, now = Date.now()): number {
  const capturedAt = Date.parse(pricing.capturedAt), expiresAt = Date.parse(pricing.expiresAt);
  if (!pricing.model || !pricing.version || !pricing.source || !Number.isFinite(capturedAt) || capturedAt > now || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt <= capturedAt
    || ![pricing.inputCentsPerMillion, pricing.outputCentsPerMillion, pricing.reasoningCentsPerMillion].every(x => Number.isFinite(x) && x > 0)
    || !Number.isFinite(pricing.safetyMultiplier) || pricing.safetyMultiplier < 1.2) throw new Error("Worker pricing snapshot is stale or invalid");
  if (![limits.maxInputTokens, limits.maxOutputTokens].every(x => Number.isSafeInteger(x) && x > 0)) throw new Error("Worker token caps are invalid");
  const worstCaseCost = Math.ceil(((limits.maxInputTokens * pricing.inputCentsPerMillion + limits.maxOutputTokens * Math.max(pricing.outputCentsPerMillion, pricing.reasoningCentsPerMillion)) / 1_000_000) * pricing.safetyMultiplier);
  if (worstCaseCost > maxBudgetCents) throw new Error("Worst-case provider spend exceeds the approved task budget");
  return worstCaseCost;
}

const requiredPointers = [
  ["ORLOOM_DATABASE_URL", "ORLOOM_DATABASE_URL_FILE"], ["ORLOOM_GITHUB_APP_ID", null], ["ORLOOM_GITHUB_PRIVATE_KEY", "ORLOOM_GITHUB_PRIVATE_KEY_FILE"],
  ["ORLOOM_R2_ACCOUNT_ID", null], ["ORLOOM_R2_ACCESS_KEY_ID", "ORLOOM_R2_ACCESS_KEY_ID_FILE"], ["ORLOOM_R2_SECRET_ACCESS_KEY", "ORLOOM_R2_SECRET_ACCESS_KEY_FILE"], ["ORLOOM_R2_BUCKET", null],
  ["ORLOOM_DEEPSEEK_API_KEY", "ORLOOM_DEEPSEEK_API_KEY_FILE"], ["ORLOOM_GITHUB_INSTALLATION_ID", null], ["ORLOOM_WORKER_SANDBOX_IMAGE_REF", null],
  ["ORLOOM_WORKER_CHECK_COMMANDS_FILE", null], ["ORLOOM_WORKER_PRICING_SNAPSHOT_FILE", null], ["ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT", null], ["ORLOOM_WORKER_SERVICE_LOCK_FILE", null],
  ["ORLOOM_VERIFIER_IMAGE", null], ["ORLOOM_VERIFIER_ID", null], ["ORLOOM_VERIFIER_ARTIFACT_ROOT", null], ["ORLOOM_VERIFIER_REPOSITORIES", null],
  ["ORLOOM_CANDIDATE_ADMISSION_ROOT", null], ["ORLOOM_VERIFICATION_POLICY_VERSION", null], ["ORLOOM_VERIFIER_CHECK_ID", null], ["ORLOOM_TRUSTED_CHECK_POLICY_JSON", null],
  ["ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON", null], ["ORLOOM_WORKER_ALLOWED_MODELS_JSON", null], ["ORLOOM_WORKER_MAX_PROVIDER_CALLS", null], ["ORLOOM_WORKER_MAX_INPUT_TOKENS", null],
  ["ORLOOM_WORKER_MAX_OUTPUT_TOKENS", null], ["ORLOOM_WORKER_MAX_WALL_SECONDS", null], ["ORLOOM_WORKER_MAX_TOOL_CALLS", null], ["ORLOOM_MAX_LANES", null],
  ["ORLOOM_CAPACITY_SLOTS", null], ["ORLOOM_CAPACITY_EVIDENCE_VERIFIED", null], ["ORLOOM_CAPACITY_EVIDENCE_SHA256", null], ["ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT", null],
] as const;

/** Checks only configuration names/pointers and manifest policy; it never reads secret contents. */
export function missingApprovedConfigurationNames(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = requiredPointers.filter(([value, file]) => !env[value]?.trim() && !(file && env[file]?.trim())).map(([value]) => value);
  for (const [value, file] of requiredPointers) {
    const pointer = file ? env[file]?.trim() : undefined;
    if (pointer && (!path.isAbsolute(pointer) || path.resolve(pointer) !== pointer)) missing.push(String(file));
  }
  return [...new Set(missing)];
}
