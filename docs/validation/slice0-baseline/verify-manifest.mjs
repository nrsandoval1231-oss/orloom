// Slice 0 baseline check: does the retained 119-file foundation manifest bind
// the exact source in this checkout? Read-only. Run with cwd = repo root.
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const repoRoot = process.argv[2] ?? process.cwd();
const manifestPath = process.argv[3];
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const blobSha1 = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

const mismatches = [];
const missing = [];
for (const entry of manifest.files) {
  const abs = `${repoRoot}/${entry.path}`;
  let bytes;
  try { bytes = await readFile(abs); } catch { missing.push(entry.path); continue; }
  const info = await stat(abs);
  const got = { size: bytes.length, sha256: sha256(bytes), git_blob_sha1: blobSha1(bytes) };
  const want = { size: entry.size, sha256: entry.sha256, git_blob_sha1: entry.git_blob_sha1 };
  for (const k of Object.keys(want)) {
    if (got[k] !== want[k]) mismatches.push(`${entry.path}: ${k} want=${want[k]} got=${got[k]}`);
  }
}

// Completeness: every tracked file matching the manifest's own exclusions must be listed.
const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
const listed = new Set(manifest.files.map((f) => f.path));
const shouldBeListed = tracked.filter((p) =>
  !p.startsWith("docs/") && !p.endsWith(".md") && !p.endsWith(".mdx") &&
  p !== "audit-runtime-sql-probe.mjs");
const notInManifest = shouldBeListed.filter((p) => !listed.has(p));
const notTracked = [...listed].filter((p) => !tracked.includes(p));

console.log(JSON.stringify({
  manifest_file_count: manifest.file_count,
  manifest_entries: manifest.files.length,
  verified_ok: manifest.files.length - mismatches.length - missing.length,
  missing_from_checkout: missing,
  hash_mismatches: mismatches,
  tracked_but_unlisted: notInManifest,
  listed_but_not_tracked: notTracked,
  complete: missing.length === 0 && mismatches.length === 0 && notInManifest.length === 0 && notTracked.length === 0,
}, null, 2));
