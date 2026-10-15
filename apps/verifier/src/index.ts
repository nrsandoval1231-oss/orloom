/** Process adapter boundary; privileged launch implementations stay in trusted host configuration. */
export { TrustedVerificationRunner, DurableArtifactStore, CHECK_POLICIES, getCheckPolicy, getCheckAttemptLifetimeMs, extractCandidateBundle } from "../../../packages/verification/src/index.js";
export type { TrustedVerificationRunnerOptions, SandboxLauncher, SandboxResult, InputBundle, RepositoryConfig } from "../../../packages/verification/src/index.js";

import path from "node:path";
import { AdmittingVerificationRunner, CandidateAdmission, DurableArtifactStore, LocalRunscLauncher } from "../../../packages/verification/src/index.js";
import { createR2CandidateArtifacts } from "../../../packages/adapters/src/candidate-artifacts.js";
import type { TrustedCheckRunner } from "../../../packages/governor/src/governor.js";
import type { RepositoryConfig } from "../../../packages/verification/src/index.js";
import { readSecret } from "../../control-plane/src/controller-authority.js";

/** Build a runner only from explicit operator configuration; absent config keeps certification disabled. */
export async function createTrustedVerificationRunner(env: NodeJS.ProcessEnv = process.env): Promise<TrustedCheckRunner | null> {
  const activationKeys = ["ORLOOM_VERIFIER_IMAGE", "ORLOOM_VERIFIER_ID", "ORLOOM_VERIFIER_ARTIFACT_ROOT", "ORLOOM_VERIFIER_REPOSITORIES", "ORLOOM_CANDIDATE_ADMISSION_ROOT", "ORLOOM_VERIFIER_LAUNCHER", "ORLOOM_VERIFICATION_POLICY_VERSION", "ORLOOM_VERIFIER_CHECK_ID"] as const;
  const configured = activationKeys.filter((key) => !!env[key]?.trim());
  if (configured.length === 0) return null;
  const required = ["ORLOOM_VERIFIER_IMAGE", "ORLOOM_VERIFIER_ID", "ORLOOM_VERIFIER_ARTIFACT_ROOT", "ORLOOM_VERIFIER_REPOSITORIES", "ORLOOM_CANDIDATE_ADMISSION_ROOT", "ORLOOM_R2_ACCOUNT_ID", "ORLOOM_R2_BUCKET"] as const;
  const accessKeyId = readSecret(env, "ORLOOM_R2_ACCESS_KEY_ID"), secretAccessKey = readSecret(env, "ORLOOM_R2_SECRET_ACCESS_KEY");
  if (required.some((key) => !env[key]?.trim()) || !accessKeyId || !secretAccessKey) throw new Error("trusted verification and candidate-admission configuration must be complete");
  const image = env.ORLOOM_VERIFIER_IMAGE!, match = /^(?:sha256:|.+@sha256:)([a-f0-9]{64})$/.exec(image);
  if (!match) throw new Error("ORLOOM_VERIFIER_IMAGE must be digest pinned");
  const verifierId = env.ORLOOM_VERIFIER_ID!;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(verifierId)) throw new Error("ORLOOM_VERIFIER_ID is invalid");
  const artifactRoot = path.resolve(env.ORLOOM_VERIFIER_ARTIFACT_ROOT!);
  const relativeToSource = path.relative(process.cwd(), artifactRoot);
  if (!path.isAbsolute(env.ORLOOM_VERIFIER_ARTIFACT_ROOT!) || artifactRoot === path.parse(artifactRoot).root || artifactRoot.split(path.sep).some((part) => ["tmp", "temp"].includes(part.toLowerCase())) || (relativeToSource === "" || (!relativeToSource.startsWith(`..${path.sep}`) && relativeToSource !== ".."))) throw new Error("artifact root must be an absolute persistent path outside temporary directories and the source worktree");
  const repositories = JSON.parse(env.ORLOOM_VERIFIER_REPOSITORIES!) as Record<string, RepositoryConfig>;
  if (!repositories || typeof repositories !== "object" || Array.isArray(repositories) || Object.keys(repositories).length === 0) throw new Error("trusted repository map is empty or invalid");
  for (const [name, config] of Object.entries(repositories)) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name) || !config || typeof config.objectStore !== "string" || !path.isAbsolute(config.objectStore) || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(config.approvedRef) || config.approvedRef.includes("..")) throw new Error("trusted repository map entry is invalid");
    const objectStore = path.resolve(config.objectStore);
    const relativeToArtifact = path.relative(artifactRoot, objectStore), relativeToSource = path.relative(process.cwd(), objectStore);
    const overlaps = (relative: string) => relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
    const artifactToObjectStore = path.relative(objectStore, artifactRoot), sourceToObjectStore = path.relative(objectStore, process.cwd());
    if (overlaps(relativeToArtifact) || overlaps(relativeToSource) || overlaps(artifactToObjectStore) || overlaps(sourceToObjectStore)) throw new Error("trusted repository object stores must be outside artifact and source roots");
  }
  const admissionRoot = path.resolve(env.ORLOOM_CANDIDATE_ADMISSION_ROOT!);
  const relativeAdmissionToSource = path.relative(process.cwd(), admissionRoot);
  const overlaps = (relative: string) => relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  if (!path.isAbsolute(env.ORLOOM_CANDIDATE_ADMISSION_ROOT!) || admissionRoot === path.parse(admissionRoot).root || admissionRoot.split(path.sep).some((part) => ["tmp", "temp"].includes(part.toLowerCase())) || overlaps(relativeAdmissionToSource) || overlaps(path.relative(admissionRoot, process.cwd()))) throw new Error("candidate admission root must be an absolute persistent path outside the source worktree and temporary directories");
  const artifactToAdmission = path.relative(artifactRoot, admissionRoot), admissionToArtifact = path.relative(admissionRoot, artifactRoot);
  if (overlaps(artifactToAdmission) || overlaps(admissionToArtifact)) throw new Error("artifact and candidate admission roots must be separate");
  if (!/^[a-f0-9]{32}$/i.test(env.ORLOOM_R2_ACCOUNT_ID!) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.ORLOOM_R2_BUCKET!)) throw new Error("R2 candidate artifact configuration is invalid");
  for (const config of Object.values(repositories)) {
    const objectStore = path.resolve(config.objectStore);
    const relativeToAdmission = path.relative(admissionRoot, objectStore), admissionToObjectStore = path.relative(objectStore, admissionRoot);
    if (overlaps(relativeToAdmission) || overlaps(admissionToObjectStore)) throw new Error("trusted repository object stores must be outside candidate admission root");
  }
  const verifierOptions = {
    repositories, artifacts: new DurableArtifactStore(artifactRoot), image, imageDigest: match[1]!, verifierId,
    launcher: new LocalRunscLauncher({ image, launcherScript: path.resolve(env.ORLOOM_VERIFIER_LAUNCHER ?? "/opt/orloom/infra/verifier-isolation/launch-verifier.sh") }),
  };
  const admission = new CandidateAdmission({root: admissionRoot, repositories, artifacts: createR2CandidateArtifacts({accountId:env.ORLOOM_R2_ACCOUNT_ID!,accessKeyId,secretAccessKey,bucket:env.ORLOOM_R2_BUCKET!})});
  return new AdmittingVerificationRunner(verifierOptions, admission);
}
