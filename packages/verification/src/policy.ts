import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";
import type { Sha256 } from "../../contracts/src/verification.js";

export interface CheckPolicy { id: string; version: string; argv: readonly string[]; cwd: string; timeoutMs: number; maxInputBytes: number; maxLogBytes: number; maxConcurrent: number; image: string; imageDigest: Sha256; digest: Sha256; }
const defaultImageDigest = "0000000000000000000000000000000000000000000000000000000000000000";
const defaultImage = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
function bindPolicy(image: string, imageDigest: Sha256): CheckPolicy {
  const unsigned = { id: "node-validate-syntax", version: "orloom.check-policy.v1", argv: ["/usr/local/bin/node", "--check", "scripts/validate.mjs"], cwd: "/input/source", timeoutMs: 60_000, maxInputBytes: 16_777_216, maxLogBytes: 65_536, maxConcurrent: 1, image, imageDigest } as const;
  return Object.freeze({ ...unsigned, digest: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") });
}
export const CHECK_POLICIES: Readonly<Record<string, CheckPolicy>> = Object.freeze({ ["node-validate-syntax"]: bindPolicy(defaultImage, defaultImageDigest) });

export function getCheckPolicy(id: string, image?: string, imageDigest?: Sha256): CheckPolicy {
  if (id !== "node-validate-syntax") throw new Error("check ID is not in the trusted finite policy catalog");
  return image && imageDigest ? bindPolicy(image, imageDigest) : CHECK_POLICIES[id]!;
}
