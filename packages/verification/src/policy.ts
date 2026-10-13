import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";
import type { Sha256 } from "../../contracts/src/verification.js";

export interface CheckPolicy { id: string; version: string; argv: readonly string[]; cwd: string; timeoutMs: number; maxInputBytes: number; maxLogBytes: number; maxConcurrent: number; image: string; imageDigest: Sha256; digest: Sha256; }
const defaultImageDigest = "0000000000000000000000000000000000000000000000000000000000000000";
const defaultImage = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
function bindPolicy(image: string, imageDigest: Sha256): CheckPolicy {
  const unsigned = { id: "node-validate-syntax", version: "orloom.check-policy.v1", argv: ["/usr/local/bin/node", "--check", "scripts/validate.mjs"], cwd: "/work/source", timeoutMs: 60_000, maxInputBytes: 16_777_216, maxLogBytes: 65_536, maxConcurrent: 1, image, imageDigest } as const;
  return Object.freeze({ ...unsigned, digest: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") });
}
export const NODE_REPO_SUITE_BINDING = Object.freeze({
  manifestVersion: "node-repo-suite-v1.deadline.v1",
  timeouts: Object.freeze({ suiteExecutionMs: 180_000, dockerAttachMs: 210_000, hostLauncherMs: 225_000, attemptLifetimeMs: 240_000 }),
  diagnostics: Object.freeze({ protocol: "orloom.suite-diagnostics.v2", maxFrames: 16, maxBytes: 4096, maxElapsedMs: 180_000, authority: "advisory-only" }),
  dependencies: Object.freeze({
    packageJsonSha256: "ce03aab4cd061600bbcf1930380861797b4b8fa7369204b701255df1551820df",
    packageLockSha256: "1c9fb3bc8b944f210492b4ae1a2750605d8495f349000464d17afcaa4f9ff1b4",
  }),
  tools: Object.freeze({ nodeVersion: "24.15.0", nodeBinarySha256: "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c", typescriptVersion: "5.9.3", stageEnvironment: Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", CI: "1", NODE_ENV: "test" }) }),
  stages: Object.freeze([
    Object.freeze({ name: "dependency-lock-admission", argv: Object.freeze(["trusted digest and repository-policy checks"]) }),
    Object.freeze({ name: "typecheck", argv: Object.freeze(["/usr/local/bin/node", "/opt/orloom-verifier/node_modules/typescript/bin/tsc", "--noEmit"]) }),
    Object.freeze({ name: "clean-build", argv: Object.freeze(["/usr/local/bin/node", "/opt/orloom-verifier/node_modules/typescript/bin/tsc"]) }),
    Object.freeze({ name: "test-discovery", argv: Object.freeze(["readdir dist/tests; require one or more *.test.js"]) }),
    Object.freeze({ name: "node-tests", argv: Object.freeze(["/usr/local/bin/node", "--test", "dist/tests/*.test.js (trusted discovered argv)"]) }),
    Object.freeze({ name: "foundation-validation", argv: Object.freeze(["/usr/local/bin/node", "scripts/validate.mjs"]) }),
    Object.freeze({ name: "offline-security-policy", argv: Object.freeze(["trusted lock/workflow/credential/dependency-path checks"]) }),
  ]),
  resources: Object.freeze({ maxInputBytes: 16_777_216, maxLogBytes: 65_536, maxConcurrent: 1, cpus: 1, memoryBytes: 1_073_741_824, pids: 128, workTmpfsBytes: 536_870_912, tempTmpfsBytes: 16_777_216, network: "none", readOnlyRoot: true, uid: 65532 }),
});
function bindSuite(image: string, imageDigest: Sha256): CheckPolicy {
  const resources = NODE_REPO_SUITE_BINDING.resources;
  const unsigned = { id: "node-repo-suite-v1", version: "orloom.node-repo-suite.v1", argv: ["/usr/local/bin/node", "/opt/orloom-verifier/run-check.js"], cwd: "/work/source", timeoutMs: NODE_REPO_SUITE_BINDING.timeouts.hostLauncherMs, maxInputBytes: resources.maxInputBytes, maxLogBytes: resources.maxLogBytes, maxConcurrent: resources.maxConcurrent, image, imageDigest, suiteManifest: NODE_REPO_SUITE_BINDING } as const;
  return Object.freeze({ ...unsigned, digest: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") });
}
export const CHECK_POLICIES: Readonly<Record<string, CheckPolicy>> = Object.freeze({
  ["node-validate-syntax"]: bindPolicy(defaultImage, defaultImageDigest),
  ["node-repo-suite-v1"]: bindSuite(defaultImage, defaultImageDigest),
});

export function getCheckPolicy(id: string, image?: string, imageDigest?: Sha256): CheckPolicy {
  if (!Object.prototype.hasOwnProperty.call(CHECK_POLICIES, id)) throw new Error("check ID is not in the trusted finite policy catalog");
  return image && imageDigest ? (id === "node-repo-suite-v1" ? bindSuite(image, imageDigest) : bindPolicy(image, imageDigest)) : CHECK_POLICIES[id]!;
}

/** Request lifetime comes only from the finite trusted policy catalog. */
export function getCheckAttemptLifetimeMs(id: string): number {
  if (!Object.prototype.hasOwnProperty.call(CHECK_POLICIES, id)) throw new Error("check ID is not in the trusted finite policy catalog");
  return id === "node-repo-suite-v1" ? NODE_REPO_SUITE_BINDING.timeouts.attemptLifetimeMs : CHECK_POLICIES[id]!.timeoutMs;
}
