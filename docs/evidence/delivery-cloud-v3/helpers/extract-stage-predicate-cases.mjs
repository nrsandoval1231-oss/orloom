import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dir = path.join(root, "candidate-f6023acade03-v3", "transfer");
const stage = await readFile(path.join(here, "stage-acceptance.sh"), "utf8");
const run = await readFile(path.join(here, "run-acceptance.sh"), "utf8");
const bindings = JSON.parse(await readFile(path.join(dir, "stage-bindings-v3.json"), "utf8"));
const runtime = JSON.parse(await readFile(path.join(dir, "runtime-files", "runtime-files-identity.json"), "utf8"));
const identity = JSON.parse(await readFile(path.join(dir, "candidate-identity.json"), "utf8"));
const manifest = await readFile(path.join(dir, "runtime-files", "runtime-files.sha256"), "utf8");
const bundleHash = createHash("sha256").update(await readFile(path.join(dir, "candidate.bundle"))).digest("hex");
const fileCount = manifest.trimEnd().split("\n").length;
const values = {
  base: bindings.baseSha, candidate: bindings.candidateSha, ref: bindings.approvedRef,
  manifest: bindings.sourceManifestSha256, payload: bindings.runtimePayloadSha256,
  source_count: bindings.sourceManifestFileCount, count: fileCount,
  compiled_count: bindings.compiledJsCount, migration_count: bindings.migrationCount,
  dependency_count: bindings.dependencyPackageCount, bundle: bundleHash
};
function predicateLine(script, fragment) {
  const line = script.split(/\r?\n/).find(value => value.startsWith("jq -e") && value.includes(fragment));
  assert(line, "stage predicate missing for " + fragment);
  const filter = [...line.matchAll(/'([^']*)'/g)][0]?.[1];
  assert(filter, "could not extract literal jq expression for " + fragment);
  const prefix = line.slice(0, line.indexOf("'" + filter + "'"));
  const args = {};
  for (const match of prefix.matchAll(/--arg(json)?\s+([a-z_]+)\s+"\$([a-z_]+)"/g)) {
    const value = values[match[3]];
    assert(value !== undefined, "unknown jq argument $" + match[3]);
    args[match[2]] = { type: match[1] ? "json" : "string", value };
  }
  return { filter, args };
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
const checks = [
  { name: "stage-bindings", document: bindings, predicate: predicateLine(stage, "stage-bindings-v3.json") },
  { name: "run-bindings", document: bindings, predicate: predicateLine(run, '"$BINDINGS"') },
  { name: "runtime-identity", document: runtime, predicate: predicateLine(stage, "runtime-files-identity.json") },
  { name: "candidate-identity", document: identity, predicate: predicateLine(stage, "candidate-identity.json") }
];
const cases = [];
function add(name, document, predicate, expected) {
  cases.push({ name, document, filter: predicate.filter, args: predicate.args, expected });
}
for (const check of checks) {
  add(check.name + ":positive", check.document, check.predicate, true);
  const fields = (check.name === "stage-bindings" || check.name === "run-bindings")
    ? ["candidateSha", "baseSha", "approvedRef", "sourceManifestSha256", "runtimePayloadSha256", "sourceManifestFileCount", "runtimeFileCount", "compiledJsCount", "migrationCount", "dependencyPackageCount"]
    : check.name === "runtime-identity"
      ? ["format", "candidate", "base", "sourceRef", "sourceManifestSha256", "payloadManifestSha256", "sourceManifestFileCount", "fileCount", "compiledJsCount", "migrationCount", "dependencyPackageCount"]
      : ["format", "candidateSha", "baseSha", "sourceRef", "sourceManifestSha256", "runtimePayloadManifestSha256", "sourceManifestFileCount", "runtimeFileCount", "compiledJsCount", "migrationCount", "bundleSha256"];
  for (const field of fields) {
    const altered = copy(check.document);
    const original = altered[field];
    altered[field] = typeof original === "number" ? ((check.name === "stage-bindings" || check.name === "run-bindings") ? 0 : original + 1) : String(original) + "-tampered";
    add(check.name + ":tampered:" + field, altered, check.predicate, false);
  }
}
process.stdout.write(JSON.stringify({
  format: "orloom-c3-delivery-cloud-stage-predicate-cases-v2",
  candidateSha: bindings.candidateSha,
  sourceManifestSha256: bindings.sourceManifestSha256,
  bundleSha256: bundleHash,
  predicateSourceSha256: createHash("sha256").update(stage).digest("hex"),
  runPredicateSourceSha256: createHash("sha256").update(run).digest("hex"),
  cases
}, null, 2) + "\n");
