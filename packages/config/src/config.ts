import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface Config {
  mode: "local" | "cloud";
  port: number;
  sessionToken: string;
  databaseUrl?: string;
  publicOrigin?: string;
  host?: string;
  workerToken?: string;
  maxLanes?: number;
  capacitySlots?: number;
  capacityEvidenceDigest?: string | null;
  capacityEvidenceExpiresAt?: string | null;
  trustedCheckPolicy?: string[];
  trustedCheckPolicyDigest?: string | null;
  workerMaxProviderCalls?: number;
  workerMaxInputTokens?: number;
  workerMaxOutputTokens?: number;
  workerMaxWallSeconds?: number;
  workerAllowedProviders?: string[];
  workerAllowedModels?: string[];
}
export type ConfigRole = "control-plane" | "github" | "artifact" | "worker";
export interface RoleConfigCheck { ok: boolean; missingFields: string[] }

export function validCodexHome(homeValue: string | undefined, jobValue: string | undefined): boolean {
  if (!homeValue?.trim() || !jobValue?.trim()) return false;
  const home = homeValue.trim();
  const job = jobValue.trim();
  const win = /^[a-z]:[\\/]/i.test(home) || home.startsWith("\\\\");
  const jobIsWindows = /^[a-z]:[\\/]/i.test(job) || job.startsWith("\\\\");
  if (win !== jobIsWindows) return false;
  const flavor = win ? path.win32 : path.posix;
  if (!flavor.isAbsolute(home) || !flavor.isAbsolute(job)) return false;
  const resolvedHome = flavor.resolve(home);
  const resolvedJob = flavor.resolve(job);
  const root = flavor.parse(resolvedHome).root;
  if (resolvedHome.toLowerCase() === root.toLowerCase()) return false;
  const relative = (from: string, to: string) => flavor.relative(from, to);
  const overlaps = (from: string, to: string) => {
    const rel = relative(from, to);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(rel));
  };
  return !overlaps(resolvedHome, resolvedJob) && !overlaps(resolvedJob, resolvedHome);
}

const roleFields: Record<ConfigRole, string[]> = {
  "control-plane": ["ORLOOM_SESSION_TOKEN", "ORLOOM_PUBLIC_ORIGIN"],
  github: ["ORLOOM_GITHUB_APP_ID", "ORLOOM_GITHUB_PRIVATE_KEY", "ORLOOM_GITHUB_WEBHOOK_SECRET"],
  artifact: ["ORLOOM_R2_ACCOUNT_ID", "ORLOOM_R2_ACCESS_KEY_ID", "ORLOOM_R2_SECRET_ACCESS_KEY", "ORLOOM_R2_BUCKET"],
  worker: ["ORLOOM_WORKER_CONTROL_URL", "ORLOOM_WORKER_TOKEN", "ORLOOM_WORKER_JOB_DIRECTORY", "CODEX_HOME"]
};

export function validateRoleConfig(role: ConfigRole, env: NodeJS.ProcessEnv): RoleConfigCheck {
  const missingFields = roleFields[role].filter(name => !env[name]?.trim());
  if (role === "github" && env.ORLOOM_GITHUB_APP_ID && !/^\d+$/.test(env.ORLOOM_GITHUB_APP_ID)) missingFields.push("ORLOOM_GITHUB_APP_ID");
  if (role === "control-plane" && env.ORLOOM_PUBLIC_ORIGIN) {
    try { const origin = new URL(env.ORLOOM_PUBLIC_ORIGIN); if (origin.protocol !== "https:" || origin.origin !== env.ORLOOM_PUBLIC_ORIGIN || origin.pathname !== "/") throw new Error(); }
    catch { missingFields.push("ORLOOM_PUBLIC_ORIGIN"); }
    if (env.ORLOOM_HOST) {
      try { if (new URL(env.ORLOOM_PUBLIC_ORIGIN).hostname.toLowerCase() !== env.ORLOOM_HOST.toLowerCase()) missingFields.push("ORLOOM_PUBLIC_ORIGIN"); }
      catch { /* invalid origin is already reported above */ }
    }
  }
  if (role === "artifact" && env.ORLOOM_R2_ACCOUNT_ID && !/^[a-f0-9]{32}$/i.test(env.ORLOOM_R2_ACCOUNT_ID)) missingFields.push("ORLOOM_R2_ACCOUNT_ID");
  if (role === "worker" && env.ORLOOM_WORKER_CONTROL_URL) {
    try { new URL(env.ORLOOM_WORKER_CONTROL_URL); } catch { missingFields.push("ORLOOM_WORKER_CONTROL_URL"); }
  }
  if (role === "worker") {
    if (env.CODEX_API_KEY?.trim()) missingFields.push("CODEX_API_KEY");
    if (env.OPENAI_API_KEY?.trim()) missingFields.push("OPENAI_API_KEY");
    if (env.CODEX_HOME?.trim() && env.ORLOOM_WORKER_JOB_DIRECTORY?.trim() && !validCodexHome(env.CODEX_HOME, env.ORLOOM_WORKER_JOB_DIRECTORY)) missingFields.push("CODEX_HOME");
    else if (env.CODEX_HOME?.trim() && !validCodexHome(env.CODEX_HOME, env.ORLOOM_WORKER_JOB_DIRECTORY)) missingFields.push("ORLOOM_WORKER_JOB_DIRECTORY");
  }
  const fields = [...new Set(missingFields)];
  return { ok: fields.length === 0, missingFields: fields };
}

export function assertRoleConfig(role: ConfigRole, env: NodeJS.ProcessEnv): void {
  const result = validateRoleConfig(role, env);
  if (!result.ok) throw new Error(`Invalid ${role} configuration; missing or invalid fields: ${result.missingFields.join(", ")}`);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const value = (name: string) => env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, "utf8").trim() : env[name];
  const mode = env.ORLOOM_MODE ?? "local";
  const port = Number(env.PORT ?? "3000");
  if (mode !== "local" && mode !== "cloud") throw new Error("ORLOOM_MODE must be local or cloud");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  if (mode === "cloud" && !value("ORLOOM_DATABASE_URL")) throw new Error("Cloud mode requires ORLOOM_DATABASE_URL");
  if (mode === "cloud" && !env.ORLOOM_HOST) throw new Error("Cloud mode requires ORLOOM_HOST");
  const resolvedEnv = { ...env, ORLOOM_SESSION_TOKEN: value("ORLOOM_SESSION_TOKEN"), ORLOOM_PUBLIC_ORIGIN: value("ORLOOM_PUBLIC_ORIGIN") };
  if (mode === "cloud") assertRoleConfig("control-plane", resolvedEnv);
  const publicOrigin = value("ORLOOM_PUBLIC_ORIGIN");
  const databaseUrl = value("ORLOOM_DATABASE_URL");
  const capacitySlots = Number(env.ORLOOM_CAPACITY_SLOTS ?? "0");
  const maxLanes = Number(env.ORLOOM_MAX_LANES?.trim() || "6");
  if (!Number.isInteger(maxLanes) || maxLanes < 1 || maxLanes > 6) throw new Error("ORLOOM_MAX_LANES must be between 1 and 6");
  if (!Number.isInteger(capacitySlots) || capacitySlots < 0 || capacitySlots > maxLanes) throw new Error("ORLOOM_CAPACITY_SLOTS must be between 0 and ORLOOM_MAX_LANES");
  const capacityEvidenceDigest = value("ORLOOM_CAPACITY_EVIDENCE_SHA256") ?? null;
  const capacityEvidenceExpiresAt = value("ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT") ?? null;
  if (capacitySlots > 0 && (env.ORLOOM_CAPACITY_EVIDENCE_VERIFIED !== "true" || !capacityEvidenceDigest || !/^[a-f0-9]{64}$/i.test(capacityEvidenceDigest) || !capacityEvidenceExpiresAt || !Number.isFinite(Date.parse(capacityEvidenceExpiresAt)) || Date.parse(capacityEvidenceExpiresAt) <= Date.now())) throw new Error("Enabled capacity requires verified, unexpired isolation evidence binding");
  let trustedCheckPolicy: string[] = [];
  if (env.ORLOOM_TRUSTED_CHECK_POLICY_JSON) {
    try { const parsed: unknown = JSON.parse(env.ORLOOM_TRUSTED_CHECK_POLICY_JSON); if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100 || parsed.some(x => typeof x !== "string" || !x.trim() || x.length > 1000)) throw new Error(); trustedCheckPolicy = parsed; }
    catch { throw new Error("ORLOOM_TRUSTED_CHECK_POLICY_JSON must be a non-empty array of trusted check identifiers"); }
  }
  const trustedCheckPolicyDigest = trustedCheckPolicy.length ? createHash("sha256").update(JSON.stringify(trustedCheckPolicy)).digest("hex") : null;
  const workerMaxProviderCalls=Number(env.ORLOOM_WORKER_MAX_PROVIDER_CALLS??"0"),workerMaxInputTokens=Number(env.ORLOOM_WORKER_MAX_INPUT_TOKENS??"0"),workerMaxOutputTokens=Number(env.ORLOOM_WORKER_MAX_OUTPUT_TOKENS??"0"),workerMaxWallSeconds=Number(env.ORLOOM_WORKER_MAX_WALL_SECONDS??"0");
  if([workerMaxProviderCalls,workerMaxInputTokens,workerMaxOutputTokens,workerMaxWallSeconds].some(x=>!Number.isSafeInteger(x)||x<0))throw new Error("Worker execution limits must be nonnegative integers");
  let workerAllowedProviders:string[]=[];try{const parsed:unknown=JSON.parse(env.ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON?.trim()||"[]");if(!Array.isArray(parsed)||parsed.some(x=>typeof x!=="string"||! /^[a-zA-Z0-9_.:-]{1,128}$/.test(x)))throw new Error();workerAllowedProviders=parsed;}catch{throw new Error("ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON must be an array of provider identifiers");}
  let workerAllowedModels:string[]=[];try{const parsed:unknown=JSON.parse(env.ORLOOM_WORKER_ALLOWED_MODELS_JSON?.trim()||"[]");if(!Array.isArray(parsed)||parsed.some(x=>typeof x!=="string"||! /^[a-zA-Z0-9_.:/-]{1,160}$/.test(x)))throw new Error();workerAllowedModels=parsed;}catch{throw new Error("ORLOOM_WORKER_ALLOWED_MODELS_JSON must be an array of exact model identifiers");}
  return {
    mode,
    port,
    sessionToken: value("ORLOOM_SESSION_TOKEN") ?? "",
    workerToken: value("ORLOOM_WORKER_TOKEN") ?? "",
    maxLanes,
    capacitySlots,
    capacityEvidenceDigest: capacitySlots ? capacityEvidenceDigest : null,
    capacityEvidenceExpiresAt: capacitySlots ? new Date(capacityEvidenceExpiresAt!).toISOString() : null,
    trustedCheckPolicy,
    trustedCheckPolicyDigest,
    workerMaxProviderCalls,workerMaxInputTokens,workerMaxOutputTokens,workerMaxWallSeconds,workerAllowedProviders,workerAllowedModels,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(env.ORLOOM_HOST ? { host: env.ORLOOM_HOST.toLowerCase() } : {}),
    ...(databaseUrl ? { databaseUrl } : {})
  };
}
