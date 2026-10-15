import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { parseTrustedCheckRequestV1, receiptDigestV1, TRUSTED_CHECK_LIMITS, type ArtifactReceiptV1, type TrustedCheckReceiptV1, type TrustedCheckRequestV1 } from "../../contracts/src/verification.js";
import { DurableArtifactStore } from "./artifact-store.js";
import { getCheckPolicy, type CheckPolicy } from "./policy.js";
import { extractCandidateBundle, readApprovedHead, type InputBundle, type RepositoryConfig } from "./repository.js";
import type { LifecycleGuard } from "../../contracts/src/lifecycle.js";
export interface SandboxResult { sandboxId: string; exitCode: number | null; signal?: string; timedOut?: boolean; stdout: Buffer; stderr: Buffer; truncated?: boolean; launcherExitCode?: number | null; launcherSignal?: string; launcherTimedOut?: boolean; launcherTruncated?: boolean; }
export interface SandboxLauncher { launch(policy: CheckPolicy, bundle: InputBundle): Promise<SandboxResult>; }
export interface TrustedVerificationRunnerOptions { repositories: Readonly<Record<string, RepositoryConfig>>; artifacts: DurableArtifactStore; launcher: SandboxLauncher; verifierId: string; image: string; imageDigest: string; now?: () => Date; }
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function timestamp(date: Date): string { return date.toISOString(); }

export class TrustedVerificationRunner {
  private active = 0;
  private readonly now: () => Date;
  constructor(private readonly options: TrustedVerificationRunnerOptions) { this.now = options.now ?? (() => new Date()); }

  async prepareBundle(repository: string, baseSha: string, candidateSha: string): Promise<InputBundle> {
    const config = this.options.repositories[repository];
    if (!config) throw new Error("repository is not in the operator trusted map");
    return extractCandidateBundle(config, baseSha as TrustedCheckRequestV1["candidateSha"], candidateSha as TrustedCheckRequestV1["candidateSha"]);
  }

  async observeHead(repository: string): Promise<{ sha: string; observedAt: string; digest: string }> {
    const config = this.options.repositories[repository];
    if (!config) throw new Error("repository is not in the operator trusted map");
    const head = await readApprovedHead(config);
    const observedAt = timestamp(this.now());
    return { sha: head, observedAt, digest: sha(Buffer.from(canonicalJson({ repository, ref: config.approvedRef, sha: head, observedAt }))) };
  }

  async verifyArtifacts(receipt: TrustedCheckReceiptV1): Promise<{ stdout: Buffer; stderr: Buffer; manifest: Buffer }> {
    const stdout = await this.options.artifacts.verify(receipt.stdout);
    const stderr = await this.options.artifacts.verify(receipt.stderr);
    const manifest = await this.options.artifacts.verify(receipt.inputManifest);
    const storedReceiptHash = createHash("sha256").update(canonicalJson(receipt)).digest("hex");
    const storedReceipt = await this.options.artifacts.read(`sha256/${storedReceiptHash}` as ArtifactReceiptV1["key"], storedReceiptHash);
    if (storedReceipt.toString("utf8") !== canonicalJson(receipt)) throw new Error("persisted receipt does not match submitted receipt");
    return { stdout, stderr, manifest };
  }

  async run(requestValue: TrustedCheckRequestV1, bundle: InputBundle, guard?: LifecycleGuard): Promise<TrustedCheckReceiptV1> {
    const request = parseTrustedCheckRequestV1(requestValue), policy = getCheckPolicy(request.checkId, this.options.image, this.options.imageDigest);
    if (request.policyVersion !== policy.version || request.policyDigest !== policy.digest || request.verifierImageDigest !== this.options.imageDigest || policy.imageDigest !== this.options.imageDigest) throw new Error("request is not bound to the configured verifier image and policy");
    if (bundle.digest !== request.inputBundleDigest || bundle.manifest.length > TRUSTED_CHECK_LIMITS.maxManifestBytes || [...bundle.files.values()].reduce((n, b) => n + b.length, bundle.manifest.length) > policy.maxInputBytes) throw new Error("trusted input bundle does not match request or policy bounds");
    const startedAt = timestamp(this.now());
    let result: SandboxResult | undefined;
    if (Date.parse(startedAt) < Date.parse(request.expiresAt) && this.active < policy.maxConcurrent) {
      // The trusted controller owns this fence. A stopped lifecycle must not
      // dispatch a new sandbox after request validation/preflight has completed.
      await guard?.();
      this.active++;
      try { result = await this.options.launcher.launch(policy, bundle); } catch { /* inability to establish execution is UNKNOWN */ }
      finally { this.active--; }
    }
    const finishedAt = timestamp(this.now());
    const unknown = !result || result.exitCode === null || !!result.signal || !!result.timedOut || !!result.truncated || (result !== undefined && (result.stdout.length > policy.maxLogBytes || result.stderr.length > policy.maxLogBytes)) || Date.parse(finishedAt) > Date.parse(request.expiresAt);
    const stdoutBytes = result ? result.stdout.subarray(0, policy.maxLogBytes) : Buffer.alloc(0), stderrBytes = result ? result.stderr.subarray(0, policy.maxLogBytes) : Buffer.alloc(0);
    const stdout = await this.options.artifacts.put(stdoutBytes), stderr = await this.options.artifacts.put(stderrBytes), inputManifest = await this.options.artifacts.put(bundle.manifest);
    const body = {
      version: "orloom.trusted-check-receipt.v1" as const, request, verifierId: this.options.verifierId, runtime: "runsc" as const,
      sandboxId: result?.sandboxId ?? `unavailable-${randomUUID()}`, outcome: unknown ? "unknown" as const : result?.exitCode === 0 ? "pass" as const : "fail" as const,
      exitCode: unknown ? null : result!.exitCode, startedAt, finishedAt, stdout, stderr, inputManifest,
    };
    const receipt: TrustedCheckReceiptV1 = { ...body, receiptDigest: receiptDigestV1(body) };
    await this.options.artifacts.put(Buffer.from(canonicalJson(receipt)));
    return receipt;
  }
}

export { DurableArtifactStore } from "./artifact-store.js";
export { CHECK_POLICIES, getCheckPolicy } from "./policy.js";
export { extractCandidateBundle } from "./repository.js";
export { readApprovedHead } from "./repository.js";
export type { InputBundle, RepositoryConfig } from "./repository.js";
