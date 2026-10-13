import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../orloom-main-review");
const buildId = process.argv[2] ?? "01";
assert(/^[0-9]{2}$/.test(buildId), "payload build ID must be two digits");
const output = resolve(here, `payload-${buildId}`);
const expectedHead = "545279c7b53fef8453c8e50ae0bc7f0d790959af";
const sourceManifestPath = join(repo, ".agent/ORL-005C1-MANIFEST.sha256");
const sourceManifest = await readFile(sourceManifestPath);
const sourceManifestSha256 = createHash("sha256").update(sourceManifest).digest("hex");
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
assert.equal(sourceHead, expectedHead, "C1a source commit changed");
assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: repo, encoding: "utf8" }).trim(), "", "C1a source tree must remain clean");
const verifyManifest = async () => {
  let count = 0;
  for (const line of sourceManifest.toString("utf8").trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    assert(match, "invalid source manifest row");
    const rel = match[2].replaceAll("/", sep);
    assert(!rel.split(sep).includes(".."), "manifest path traversal");
    const absolute = resolve(repo, rel);
    assert(absolute.startsWith(`${repo}${sep}`), "manifest path escaped repo");
    const stat = await lstat(absolute);
    assert(stat.isFile() && !stat.isSymbolicLink(), "manifest entry must be an ordinary file");
    assert.equal(createHash("sha256").update(await readFile(absolute)).digest("hex"), match[1], `source hash mismatch: ${match[2]}`);
    count++;
  }
  assert.equal(count, 36, "unexpected frozen source manifest size");
};
await verifyManifest();
try { await lstat(output); throw new Error("payload already exists; refusing overwrite"); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const app = join(output, "app");
const files = [];
const addFile = async (source, destination) => {
  const stat = await lstat(source);
  assert(stat.isFile() && !stat.isSymbolicLink(), `payload source is not a regular file: ${relative(repo, source)}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
  files.push(destination);
};
const addCompiledTree = async (relativePath) => {
  const sourceRoot = join(repo, "dist", relativePath);
  const walk = async (source, destination) => {
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const from = join(source, entry.name), to = join(destination, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in compiled allowlist: ${relative(repo, from)}`);
      if (entry.isDirectory()) await walk(from, to);
      else if (entry.isFile() && entry.name.endsWith(".js")) await addFile(from, to);
      else if (!entry.isFile()) throw new Error(`unexpected compiled entry: ${relative(repo, from)}`);
    }
  };
  await walk(sourceRoot, join(app, relativePath));
};

for (const path of [
  "apps/control-plane/src/server.js",
  "packages/contracts/src",
  "packages/config/src",
  "packages/governor/src",
  "packages/judgment/src",
  "packages/stuck-resolver/src",
  "packages/learning/src",
]) {
  if (path.endsWith(".js")) await addFile(join(repo, "dist", path), join(app, path));
  else await addCompiledTree(path);
}
for (const name of ["001_initial.sql", "002_missions.sql", "003_recovery.sql"]) await addFile(join(repo, "db/migrations", name), join(app, "db/migrations", name));
await addFile(join(here, "runtime-proof.mjs"), join(app, "runtime-proof.mjs"));
await writeFile(join(app, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
files.push(join(app, "package.json"));

for (const name of ["pg", "pg-connection-string", "pg-int8", "pg-pool", "pg-protocol", "pg-types", "pgpass", "postgres-array", "postgres-bytea", "postgres-date", "postgres-interval", "split2", "xtend"]) {
  const source = join(repo, "node_modules", name);
  const target = join(app, "node_modules", name);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`dependency symlink is not allowed: ${name}/${entry.name}`);
    if (entry.isDirectory()) await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    else if (entry.isFile()) await addFile(from, to);
    else throw new Error(`unexpected dependency entry: ${name}/${entry.name}`);
  }
}

const rows = [];
const walkPayload = async dir => {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("payload contains a symlink");
    if (entry.isDirectory()) await walkPayload(path);
    else if (entry.isFile()) rows.push(`${createHash("sha256").update(await readFile(path)).digest("hex")}  ${relative(app, path).split(sep).join("/")}`);
    else throw new Error("payload contains a non-file entry");
  }
};
await walkPayload(app);
const payloadManifest = `${rows.join("\n")}\n`;
await writeFile(join(here, `payload-manifest-${buildId}.sha256`), payloadManifest, { flag: "wx" });
const packageLockSha256 = createHash("sha256").update(await readFile(join(repo, "package-lock.json"))).digest("hex");
const identity = {
  sourceHead, sourceManifestSha256, packageLockSha256,
  runnerSha256: createHash("sha256").update(await readFile(join(here, "runtime-proof.mjs"))).digest("hex"),
  payloadManifestSha256: createHash("sha256").update(payloadManifest).digest("hex"),
  fileCount: rows.length,
};
await writeFile(join(here, `payload-identity-${buildId}.json`), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`source=${sourceHead} source_manifest=${sourceManifestSha256} payload=${identity.payloadManifestSha256} files=${rows.length}\n`);
