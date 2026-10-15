import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { TRUSTED_CHECK_LIMITS, type CommitSha, type Sha256 } from "../../contracts/src/verification.js";

const exec = promisify(execFile);
export interface RepositoryConfig { objectStore: string; approvedRef: string; executionInputProfile?: "orloom-execution-v1"; }
export interface InputFile { path: string; sha256: Sha256; bytes: number; }
export interface InputBundle { digest: Sha256; manifest: Buffer; files: Map<string, Buffer>; }
const MAX_FILES = 4_000, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_INPUT = TRUSTED_CHECK_LIMITS.maxInputBundleBytes;
const digest = (value: Uint8Array): Sha256 => createHash("sha256").update(value).digest("hex");
export type RepositoryGit = (repo: string, args: string[], maxBuffer?: number) => Promise<Buffer>;
const git: RepositoryGit = async (repo, args, maxBuffer = MAX_INPUT + 1024 * 1024): Promise<Buffer> => {
  const { stdout } = await exec("git", ["--git-dir", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "submodule.recurse=false", ...args], { encoding: "buffer", maxBuffer, windowsHide: true, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? process.env.USERPROFILE ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" } });
  return stdout as Buffer;
};
function safePath(file: string): void {
  if (!file || file.startsWith("/") || file.includes("\\") || file.includes("\0") || file.split("/").some((p) => !p || p === "." || p === "..") || /^[a-zA-Z]:/.test(file)) throw new Error("unsafe repository path");
}

/** Read raw Git tree/blob objects; never checks out candidate content on the host. */
export async function extractCandidateBundle(config: RepositoryConfig, baseSha: CommitSha, candidateSha: CommitSha, readGit: RepositoryGit = git): Promise<InputBundle> {
  if (config.executionInputProfile !== undefined && config.executionInputProfile !== "orloom-execution-v1") throw new Error("unknown execution input profile");
  const repo = path.resolve(config.objectStore);
  if (!path.isAbsolute(config.objectStore) || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(config.approvedRef) || config.approvedRef.includes("..")) throw new Error("invalid trusted repository map entry");
  if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error("invalid candidate or base commit SHA");
  const [bare, alternates, shallow] = await Promise.all([
    readGit(repo, ["rev-parse", "--is-bare-repository"]).then((b) => b.toString("ascii").trim() === "true"),
    access(path.join(repo, "objects", "info", "alternates"), constants.F_OK).then(() => true, () => false),
    access(path.join(repo, "shallow"), constants.F_OK).then(() => true, () => false),
  ]);
  if (!bare || alternates || shallow) throw new Error("object store must be a complete bare repository without alternates or shallow boundaries");
  const repositoryConfig = await readFile(path.join(repo, "config"), "utf8");
  if (/\bpromisor\s*=\s*true|\bpartialclone\s*=|^\s*\[include(?:if)?\b/im.test(repositoryConfig.toLowerCase())) throw new Error("partial, promisor, or externally included repository configuration is not trusted");
  const objectType = (await readGit(repo, ["cat-file", "-t", candidateSha])).toString("ascii").trim();
  if (objectType !== "commit") throw new Error("candidate is not a commit object");
  const reach = await readGit(repo, ["merge-base", "--is-ancestor", candidateSha, config.approvedRef]).then(() => true, () => false);
  if (!reach) throw new Error("candidate is not reachable from approved ref");
  if ((await readGit(repo, ["cat-file", "-t", baseSha])).toString("ascii").trim() !== "commit") throw new Error("base is not a commit object");
  if (!(await readGit(repo, ["merge-base", "--is-ancestor", baseSha, candidateSha]).then(() => true, () => false))) throw new Error("candidate is not a descendant of approved base");
  const treeLine = (await readGit(repo, ["rev-parse", `${candidateSha}^{tree}`])).toString("ascii").trim();
  if (!/^[a-f0-9]{40}$/.test(treeLine)) throw new Error("invalid tree object id");
  const listing = await readGit(repo, ["ls-tree", "-r", "-z", "--full-tree", treeLine]);
  let decodedListing: string;
  try { decodedListing = new TextDecoder("utf-8", { fatal: true }).decode(listing); } catch { throw new Error("candidate path is not valid UTF-8"); }
  const rows = decodedListing.split("\0").filter(Boolean);
  if (rows.length > MAX_FILES) throw new Error("candidate contains too many files");
  const files = new Map<string, Buffer>(), names = new Set<string>(); let total = 0, excludedFiles = 0, excludedBytes = 0;
  for (const row of rows) {
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("malformed Git tree entry");
    const header = row.slice(0, tab), name = row.slice(tab + 1);
    const match = /^(100644|100755|120000|160000) blob ([a-f0-9]{40})$/.exec(header);
    if (!match || match[1] === "120000" || match[1] === "160000") throw new Error("candidate contains a symlink, gitlink, or unsupported tree entry");
    const blobId = match[2]!;
    safePath(name);
    const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(folded)) throw new Error("candidate contains case-colliding paths");
    names.add(folded);
    const selected = !config.executionInputProfile || executionPath(name);
    const sizeText = (await readGit(repo, ["cat-file", "-s", blobId])).toString("ascii").trim(), size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || (selected && total + size > MAX_INPUT)) throw new Error("candidate exceeds verifier input bounds");
    if (!selected) { excludedFiles++; excludedBytes += size; continue; }
    const bytes = await readGit(repo, ["cat-file", "blob", blobId], MAX_FILE_BYTES + 1);
    if (bytes.length !== size) throw new Error("blob byte count mismatch");
    total += size; files.set(name, bytes);
  }
  const entries: InputFile[] = [...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([file, bytes]) => ({ path: file, sha256: digest(bytes), bytes: bytes.length }));
  const manifest = Buffer.from(canonicalJson({ version: "orloom.input-manifest.v1", candidateSha, ...(config.executionInputProfile ? { executionProfile: config.executionInputProfile, treeSha: treeLine, excludedFiles, excludedBytes } : {}), files: entries }), "utf8");
  if (manifest.length > TRUSTED_CHECK_LIMITS.maxManifestBytes) throw new Error("input manifest exceeds limit");
  if (total + manifest.length > MAX_INPUT) throw new Error("candidate source plus manifest exceeds verifier input cap");
  return { digest: digest(manifest), manifest, files };
}

export async function readApprovedHead(config: RepositoryConfig, readGit: RepositoryGit = git): Promise<CommitSha> {
  if (!path.isAbsolute(config.objectStore) || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(config.approvedRef) || config.approvedRef.includes("..")) throw new Error("invalid trusted repository map entry");
  const repo = path.resolve(config.objectStore);
  const bare = await readGit(repo, ["rev-parse", "--is-bare-repository"]).then((b) => b.toString("ascii").trim() === "true");
  if (!bare || await access(path.join(repo, "objects", "info", "alternates"), constants.F_OK).then(() => true, () => false) || await access(path.join(repo, "shallow"), constants.F_OK).then(() => true, () => false)) throw new Error("trusted object store is incomplete or externally dependent");
  const sha = (await readGit(repo, ["rev-parse", "--verify", `${config.approvedRef}^{commit}`])).toString("ascii").trim();
  if (!/^[a-f0-9]{40}$/.test(sha) || (await readGit(repo, ["cat-file", "-t", sha])).toString("ascii").trim() !== "commit") throw new Error("trusted ref does not resolve to a commit");
  return sha;
}

/** Controller-owned classification, never read from candidate configuration.
 * Unknown roots fail closed; additions require explicit trusted code review.
 * All regular-file/path/size checks still apply to excluded records. */
function executionPath(name: string): boolean {
  if (name === "docs/validation/slice1c-review-findings/verify-1c.mjs") return true;
  if ([".agent/", "docs/evidence/", "docs/validation/", "work/", "prototypes/", "forge/"].some(prefix => name.startsWith(prefix)) || ["forge", "PR23-receipt-sha256.txt", "PR23-source-sha256.txt"].includes(name)) return false;
  if (["apps/", "packages/", "tests/", "scripts/", "db/", "deploy/", "infra/", "docs/"].some(prefix => name.startsWith(prefix)) || [".dockerignore", ".env.example", ".gitattributes", ".gitignore", "README.md", "package.json", "package-lock.json", "tsconfig.json"].includes(name)) return true;
  throw new Error(`unclassified execution input path: ${name}`);
}
