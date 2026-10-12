import { access, readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const key of ["typecheck", "test", "build", "validate"]) assert.equal(typeof pkg.scripts[key], "string", `missing script ${key}`);
assert.match(pkg.dependencies["@openai/codex-sdk"], /^\d+\.\d+\.\d+$/);
const workflowPath = ".github/workflows";
try { await access(workflowPath); throw new Error("Repository must not define GitHub Actions workflows"); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
const env = await readFile(".env.example", "utf8");
for (const line of env.split(/\r?\n/)) if (line.includes("=")) {
  const [name, value] = line.split("=", 2);
  if (name !== "ORLOOM_MODE") assert.equal(value.trim(), "", "example credentials must be blank");
}
const gitignore = await readFile(".gitignore", "utf8");
for (const entry of ["secrets/", "credentials/", "state/", "*.pem", "*.key", "*.p12", "*.pfx", "credentials.json"]) assert(gitignore.includes(entry), `missing ignore rule ${entry}`);
const dockerignore = await readFile(".dockerignore", "utf8");
for (const entry of ["secrets", "credentials", "state", "*.pem", "*.key", "*.p12", "*.pfx", "credentials.json"]) assert(dockerignore.includes(entry), `missing Docker ignore rule ${entry}`);
const migration = await readFile("db/migrations/001_initial.sql", "utf8");
assert.match(migration, /status IN \('queued','leased','running','succeeded','failed','unknown'\)/);
await readdir("docs");
process.stdout.write("Foundation structure validation passed.\n");
