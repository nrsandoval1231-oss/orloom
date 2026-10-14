import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";

export type Sha256 = string;
export type CommitSha = string;
export type ArtifactRef = `sha256/${string}`;
export type CheckOutcome = "pass" | "fail" | "unknown";

export const TRUSTED_CHECK_LIMITS = Object.freeze({
  maxTextLength: 256,
  maxRepositoryLength: 128,
  maxManifestBytes: 1_048_576,
  maxLogBytes: 65_536,
  maxInputBundleBytes: 16_777_216,
  maxLeaseEpoch: 2_147_483_647,
  maxLifetimeMs: 10 * 60_000,
});

export interface TrustedCheckRequestV1 {
  version: "orloom.trusted-check-request.v1";
  attemptId: string;
  missionId: string;
  sliceId: string;
  leaseEpoch: number;
  repository: string;
  candidateSha: CommitSha;
  expectedLocalHeadSha: CommitSha;
  planDigest: Sha256;
  checkId: string;
  policyVersion: string;
  policyDigest: Sha256;
  verifierImageDigest: Sha256;
  inputBundleDigest: Sha256;
  requestedAt: string;
  expiresAt: string;
}

export interface ArtifactReceiptV1 {
  key: ArtifactRef;
  sha256: Sha256;
  bytes: number;
}

export interface TrustedCheckReceiptV1 {
  version: "orloom.trusted-check-receipt.v1";
  request: TrustedCheckRequestV1;
  verifierId: string;
  runtime: "runsc";
  sandboxId: string;
  outcome: CheckOutcome;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  stdout: ArtifactReceiptV1;
  stderr: ArtifactReceiptV1;
  inputManifest: ArtifactReceiptV1;
  receiptDigest: Sha256;
}

/** Public binding metadata only; capability bytes stay in the trusted channel. */
export interface TrustedVerifierCapabilityV1 {
  attemptId: string;
  verifierId: string;
  expiresAt: string;
}

export interface CheckCertificateV1 {
  version: "orloom.check-certificate.v1";
  certificateId: string;
  attemptId: string;
  missionId: string;
  sliceId: string;
  leaseEpoch: number;
  repository: string;
  candidateSha: CommitSha;
  localHeadSha: CommitSha;
  checkId: string;
  planDigest: Sha256;
  policyVersion: string;
  policyDigest: Sha256;
  receiptDigest: Sha256;
  certifiedAt: string;
  scope: "local-exact-commit";
}

export interface TrustedCheckService {
  prepare(missionId: string, sliceId: string, checkId: string): Promise<TrustedCheckRequestV1>;
  run(request: TrustedCheckRequestV1): Promise<TrustedCheckReceiptV1>;
  submit(receipt: TrustedCheckReceiptV1, capability: string): Promise<CheckCertificateV1 | null>;
  getCertificate(missionId: string, sliceId: string, checkId: string): Promise<CheckCertificateV1 | null>;
}

const record = (value: unknown, fields: readonly string[], label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== fields.length || fields.some((field) => !Object.hasOwn(item, field))) throw new Error(`${label} has missing or unknown fields`);
  return item;
};
const string = (value: unknown, label: string, max: number = TRUSTED_CHECK_LIMITS.maxTextLength): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value) throw new Error(`${label} is invalid`);
  return value;
};
const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
};
const commit = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a lowercase commit SHA`);
  return value;
};
const uuid = (value: unknown, label: string): string => {
  const result = string(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new Error(`${label} must be a UUID`);
  return result;
};
const sliceId = (value: unknown): string => {
  const result = string(value, "sliceId", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) throw new Error("sliceId must match the mission slice ID format");
  return result;
};
const timestamp = (value: unknown, label: string): number => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new Error(`${label} must be UTC ISO-8601 with milliseconds`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} is invalid`);
  return parsed;
};
const integer = (value: unknown, label: string, max: number, min = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
};

const requestFields = ["version", "attemptId", "missionId", "sliceId", "leaseEpoch", "repository", "candidateSha", "expectedLocalHeadSha", "planDigest", "checkId", "policyVersion", "policyDigest", "verifierImageDigest", "inputBundleDigest", "requestedAt", "expiresAt"] as const;
export function parseTrustedCheckRequestV1(value: unknown): TrustedCheckRequestV1 {
  const r = record(value, requestFields, "request");
  if (r.version !== "orloom.trusted-check-request.v1") throw new Error("request version is unsupported");
  const requested = timestamp(r.requestedAt, "requestedAt"), expires = timestamp(r.expiresAt, "expiresAt");
  if (expires <= requested || expires - requested > TRUSTED_CHECK_LIMITS.maxLifetimeMs) throw new Error("request expiry window is invalid");
  const repository = string(r.repository, "repository", TRUSTED_CHECK_LIMITS.maxRepositoryLength);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error("repository must be canonical lowercase owner/repo");
  const result: TrustedCheckRequestV1 = {
    version: "orloom.trusted-check-request.v1", attemptId: uuid(r.attemptId, "attemptId"),
    missionId: uuid(r.missionId, "missionId"), sliceId: sliceId(r.sliceId),
    leaseEpoch: integer(r.leaseEpoch, "leaseEpoch", TRUSTED_CHECK_LIMITS.maxLeaseEpoch, 1), repository,
    candidateSha: commit(r.candidateSha, "candidateSha"), expectedLocalHeadSha: commit(r.expectedLocalHeadSha, "expectedLocalHeadSha"),
    planDigest: digest(r.planDigest, "planDigest"), checkId: string(r.checkId, "checkId"), policyVersion: string(r.policyVersion, "policyVersion"),
    policyDigest: digest(r.policyDigest, "policyDigest"), verifierImageDigest: digest(r.verifierImageDigest, "verifierImageDigest"),
    inputBundleDigest: digest(r.inputBundleDigest, "inputBundleDigest"), requestedAt: r.requestedAt as string, expiresAt: r.expiresAt as string,
  };
  return result;
}
export function trustedCheckRequestDigestV1(value: TrustedCheckRequestV1): Sha256 {
  return createHash("sha256").update(canonicalJson(parseTrustedCheckRequestV1(value))).digest("hex");
}

const artifactFields = ["key", "sha256", "bytes"] as const;
function parseArtifact(value: unknown, label: string, max: number): ArtifactReceiptV1 {
  const a = record(value, artifactFields, label);
  const hash = digest(a.sha256, `${label}.sha256`);
  if (a.key !== `sha256/${hash}`) throw new Error(`${label}.key must match its digest`);
  return { key: a.key as ArtifactRef, sha256: hash, bytes: integer(a.bytes, `${label}.bytes`, max) };
}
const receiptFields = ["version", "request", "verifierId", "runtime", "sandboxId", "outcome", "exitCode", "startedAt", "finishedAt", "stdout", "stderr", "inputManifest", "receiptDigest"] as const;
export function receiptDigestV1(receipt: Omit<TrustedCheckReceiptV1, "receiptDigest"> | TrustedCheckReceiptV1): Sha256 {
  const { receiptDigest: _ignored, ...body } = receipt as TrustedCheckReceiptV1;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}
export function parseTrustedCheckReceiptV1(value: unknown): TrustedCheckReceiptV1 {
  const r = record(value, receiptFields, "receipt");
  if (r.version !== "orloom.trusted-check-receipt.v1") throw new Error("receipt version is unsupported");
  const request = parseTrustedCheckRequestV1(r.request);
  const started = timestamp(r.startedAt, "startedAt"), finished = timestamp(r.finishedAt, "finishedAt");
  const requested = Date.parse(request.requestedAt), expires = Date.parse(request.expiresAt);
  if (finished < started || started < requested || (r.outcome !== "unknown" && finished > expires)) throw new Error("receipt time range is invalid");
  if (r.runtime !== "runsc" || typeof r.outcome !== "string" || !["pass", "fail", "unknown"].includes(r.outcome)) throw new Error("receipt runtime or outcome is invalid");
  if (r.outcome === "pass" && r.exitCode !== 0 || r.outcome === "fail" && (typeof r.exitCode !== "number" || !Number.isInteger(r.exitCode) || r.exitCode < 1 || r.exitCode > 255) || r.outcome === "unknown" && r.exitCode !== null) throw new Error("receipt outcome and exit code disagree");
  const result: TrustedCheckReceiptV1 = {
    version: "orloom.trusted-check-receipt.v1", request,
    verifierId: string(r.verifierId, "verifierId"), runtime: "runsc", sandboxId: string(r.sandboxId, "sandboxId"),
    outcome: r.outcome as CheckOutcome, exitCode: r.exitCode as number | null,
    startedAt: r.startedAt as string, finishedAt: r.finishedAt as string,
    stdout: parseArtifact(r.stdout, "stdout", TRUSTED_CHECK_LIMITS.maxLogBytes),
    stderr: parseArtifact(r.stderr, "stderr", TRUSTED_CHECK_LIMITS.maxLogBytes),
    inputManifest: parseArtifact(r.inputManifest, "inputManifest", TRUSTED_CHECK_LIMITS.maxManifestBytes),
    receiptDigest: digest(r.receiptDigest, "receiptDigest"),
  };
  if (result.receiptDigest !== receiptDigestV1(result)) throw new Error("receipt digest mismatch");
  return result;
}

export function parseTrustedVerifierCapabilityV1(value: unknown): TrustedVerifierCapabilityV1 {
  const c = record(value, ["attemptId", "verifierId", "expiresAt"], "capability metadata");
  return { attemptId: uuid(c.attemptId, "attemptId"), verifierId: string(c.verifierId, "verifierId"), expiresAt: (timestamp(c.expiresAt, "expiresAt"), c.expiresAt as string) };
}

export function parseCheckCertificateV1(value: unknown): CheckCertificateV1 {
  const fields = ["version", "certificateId", "attemptId", "missionId", "sliceId", "leaseEpoch", "repository", "candidateSha", "localHeadSha", "checkId", "planDigest", "policyVersion", "policyDigest", "receiptDigest", "certifiedAt", "scope"] as const;
  const c = record(value, fields, "certificate");
  if (c.version !== "orloom.check-certificate.v1" || c.scope !== "local-exact-commit") throw new Error("certificate version or scope is invalid");
  const repository = string(c.repository, "repository", TRUSTED_CHECK_LIMITS.maxRepositoryLength);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error("repository must be canonical lowercase owner/repo");
  timestamp(c.certifiedAt, "certifiedAt");
  return {
    version: "orloom.check-certificate.v1", certificateId: uuid(c.certificateId, "certificateId"),
    attemptId: uuid(c.attemptId, "attemptId"), missionId: uuid(c.missionId, "missionId"), sliceId: sliceId(c.sliceId),
    leaseEpoch: integer(c.leaseEpoch, "leaseEpoch", TRUSTED_CHECK_LIMITS.maxLeaseEpoch, 1), repository,
    candidateSha: commit(c.candidateSha, "candidateSha"), localHeadSha: commit(c.localHeadSha, "localHeadSha"),
    checkId: string(c.checkId, "checkId"), planDigest: digest(c.planDigest, "planDigest"),
    policyVersion: string(c.policyVersion, "policyVersion"), policyDigest: digest(c.policyDigest, "policyDigest"),
    receiptDigest: digest(c.receiptDigest, "receiptDigest"), certifiedAt: c.certifiedAt as string, scope: "local-exact-commit",
  };
}

/** Controller-derived identity, never an owner/browser override or a builder pass. */
export interface CandidateAdmissionBindingV1 {
  version: "orloom.candidate-admission.v1";
  missionId: string; sliceId: string; leaseEpoch: number;
  repository: string; baseSha: string; candidateSha: string;
  planDigest: string; trustedCheckPolicyDigest: string;
  scopes: string[]; evidenceRefs: string[];
}

/** Retryable admission conditions must not permanently invalidate a candidate. */
export class CandidateAdmissionTransientError extends Error {}
export class CandidateArtifactInvalidError extends Error {}
