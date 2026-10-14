/** Process adapter boundary; privileged launch implementations stay in trusted host configuration. */
export { TrustedVerificationRunner, DurableArtifactStore, CHECK_POLICIES, getCheckPolicy, getCheckAttemptLifetimeMs, extractCandidateBundle } from "../../../packages/verification/src/index.js";
export type { TrustedVerificationRunnerOptions, SandboxLauncher, SandboxResult, InputBundle, RepositoryConfig } from "../../../packages/verification/src/index.js";

import path from "node:path";
import { DurableArtifactStore, LocalRunscLauncher, TrustedVerificationRunner } from "../../../packages/verification/src/index.js";
import type { RepositoryConfig } from "../../../packages/verification/src/index.js";

/** Build a runner only from explicit operator configuration; absent config keeps certification disabled. */
export async function createTrustedVerificationRunner(env: NodeJS.ProcessEnv = process.env): Promise<TrustedVerificationRunner | null> {
  const required = ["ORLOOM_VERIFIER_IMAGE", "ORLOOM_VERIFIER_ID", "ORLOOM_VERIFIER_ARTIFACT_ROOT", "ORLOOM_VERIFIER_REPOSITORIES"] as const;
  if (required.some((key) => !env[key])) return null;
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
  return new TrustedVerificationRunner({
    repositories, artifacts: new DurableArtifactStore(artifactRoot), image, imageDigest: match[1]!, verifierId,
    launcher: new LocalRunscLauncher({ image, launcherScript: path.resolve(env.ORLOOM_VERIFIER_LAUNCHER ?? "/opt/orloom/infra/verifier-isolation/launch-verifier.sh") }),
  });
}
