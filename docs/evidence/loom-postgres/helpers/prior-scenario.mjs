import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const source = process.env.C4_PG_SOURCE, runtime = process.env.C4_PG_RUNTIME;
const evidence = process.env.C4_PG_EVIDENCE, expectedSha = process.env.C4_PG_EXPECTED_SHA;
const configPath = process.env.C4_PG_CONFIG;
assert(source && runtime && evidence && configPath);
assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/);
const rel = relative(runtime, evidence);
assert(rel && rel !== ".." && !rel.startsWith(".." + sep));
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), expectedSha);
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }).trim(), "");
const pgConfig = JSON.parse(await readFile(configPath, "utf8"));
const connectionString = "postgresql://" + encodeURIComponent(pgConfig.user) + ":" + encodeURIComponent(pgConfig.password) + "@" + pgConfig.host + ":" + pgConfig.port + "/" + pgConfig.database;
const load = (p) => import(pathToFileURL(join(source, "dist", p)).href);
const pg = await import(pathToFileURL(join(source, "node_modules", "pg", "lib", "index.js")).href);
const Pool = pg.default?.Pool;
assert.equal(typeof Pool, "function");
const [migrator, sqlMod, jobsMod, govMod, control, canonical] = await Promise.all([
  load("packages/contracts/src/postgres-store.js"), load("packages/contracts/src/sql-mission-store.js"),
  load("packages/contracts/src/memory-store.js"), load("packages/governor/src/governor.js"),
  load("apps/control-plane/src/server.js"), load("packages/judgment/src/canonical.js")
]);
const playwright = createRequire(import.meta.url)("C:/Users/nrsan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const policy = "b".repeat(64), recovery = "c".repeat(64);
const strategyId = "fixture-strategy", targetCheckId = "fixture-target", checkId = "fixture-check";
const strategies = { [strategyId]: { checkId, version: "fixture-v1", expectedSignal: "Controlled fixture", scopeClasses: ["*"], targetCheckIds: [targetCheckId] } };
const out = join(evidence, "loom-browser");
await mkdir(out, { recursive: true });
let pool, server, browser, migrationStore;
function executor(db) {
  return { query: (q, p) => db.query(q, p), async transaction(work) {
    const c = await db.connect();
    try { await c.query("BEGIN"); const value = await work({ query: (q, p) => c.query(q, p) }); await c.query("COMMIT"); return value; }
    catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
  }};
}
function listen(s) {
  return new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", () => {
    const a = s.address(); if (!a || typeof a === "string") return reject(new Error("loopback bind failed"));
    resolve("http://127.0.0.1:" + a.port);
  }); });
}
async function closeServer() { if (server?.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
try {
  // Canonical production migrator applies migrations 001 through 007.
  migrationStore = await migrator.PostgresJobStore.connect(connectionString);
  await migrationStore.close(); migrationStore = null;
  pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000, statement_timeout: 15000, application_name: "loom-pg-browser-proof" });
  pool.on("error", () => {});
  const store = new sqlMod.SqlMissionStore(executor(pool));
  const ownerToken = randomBytes(32).toString("base64url");
  const config = { mode: "local", sessionToken: ownerToken, workerToken: randomBytes(32).toString("base64url"), maxLanes: 1, capacitySlots: 1, trustedCheckPolicyDigest: policy, recoveryPolicyDigest: recovery, trustedCheckPolicy: [strategyId, targetCheckId], trustedStrategies: strategies, workerMaxProviderCalls: 0, workerMaxInputTokens: 0, workerMaxOutputTokens: 0, workerMaxWallSeconds: 0, workerAllowedProviders: [], workerAllowedModels: [] };
  const governor = new govMod.MissionGovernor(store, { maxLanes: 1, capacitySlots: 1, leaseSeconds: 300, trustedCheckPolicyDigest: policy, recoveryPolicyDigest: recovery, trustedCheckPolicy: [strategyId, targetCheckId], trustedStrategies: strategies, executionConfigured: true, progressLimits: { maxProviderCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxWallSeconds: 0 } });
  await governor.configureCapacity(1, policy, new Date(Date.now() + 120000).toISOString());
  const mission = await governor.submit({ repository: "controlled/loom-browser-proof", baseSha: "a".repeat(40), objective: "Controlled PostgreSQL viewer proof (no builder executed)", acceptance: ["Render persisted mission history", "Remain open pending certification and integration"], budgetCents: 100 });
  const slices = [
    { id: "viewer-proof", objective: "Render a persisted owner-visible event", dependencies: [], owner: "controlled-fixture", scopes: ["docs/loom-proof.md"], checks: [strategyId], budgetCents: 50 },
    { id: "completion-gate", objective: "Remain open until certified and integrated", dependencies: ["viewer-proof"], owner: "controlled-fixture", scopes: ["docs/completion-gate.md"], checks: [strategyId], budgetCents: 50 }
  ];
  await governor.recommend(mission.id, slices, "controlled-browser-proof"); await governor.approve(mission.id);
  server = control.createControlPlane(config, new jobsMod.MemoryJobStore(), store);
  const base = await listen(server);
  assert.equal((await fetch(base + "/api/missions/" + mission.id + "/loom?after=0")).status, 401);
  const login = await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0]; assert(cookie?.startsWith("orloom_session="));
  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const cookieValue = decodeURIComponent(cookie.slice("orloom_session=".length));
  await page.context().addCookies([{ name: "orloom_session", value: cookieValue, url: base, httpOnly: true, sameSite: "Strict" }]);
  const url = base + "/loom?mission=" + encodeURIComponent(mission.id);
  await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
  await page.locator("#live[data-state='live']").waitFor({ timeout: 10000 });
  await page.locator("#objective").getByText("Controlled PostgreSQL viewer proof", { exact: false }).waitFor();
  await page.locator("#events-desktop").getByText("Mission created", { exact: false }).waitFor();
  assert.equal(await page.locator("#events-desktop").getByText("Governor decision recorded", { exact: false }).count(), 0);
  await page.screenshot({ path: join(out, "loom-desktop.png"), fullPage: true });
  const grant = await store.claim(300, policy, new Date(), recovery); assert(grant);
  const record = await store.getMission(mission.id);
  const planDigest = createHash("sha256").update(canonical.canonicalJson(record.plan.slices)).digest("hex");
  const progress = { version: "orloom.progress.v1", eventId: "loom-proof-" + randomUUID(), missionId: mission.id, sliceId: grant.slice.id, leaseEpoch: grant.epoch, ordinal: 1, planDigest, trustedCheckPolicyDigest: policy, recoveryPolicyDigest: recovery, phase: "trusted_check", status: "started", reasonCode: "other", strategyId, targetCheckId, checkId, counters: { providerCalls: 0, inputTokens: 0, outputTokens: 0, wallMs: 0 }, evidenceRefs: [] };
  await governor.recordProgress(progress, grant.leaseToken, grant.capabilityToken);
  assert((await store.events(mission.id, 0)).some(e => e.type === "slice.progress" && e.data?.eventId === progress.eventId));
  await page.locator("#refresh-desktop").click();
  await page.locator("#events-desktop").getByText("Governor decision recorded", { exact: false }).waitFor({ timeout: 10000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#events-desktop").getByText("Governor decision recorded", { exact: false }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#live").getAttribute("data-state"), "live");
  assert.notEqual(await page.locator("#notice").innerText(), "Every planned slice has durable certification and integration evidence.");
  await page.screenshot({ path: join(out, "loom-reloaded.png"), fullPage: true });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobile.context().addCookies([{ name: "orloom_session", value: cookieValue, url: base, httpOnly: true, sameSite: "Strict" }]);
  await mobile.goto(url, { waitUntil: "networkidle", timeout: 20000 });
  await mobile.locator("#live[data-state='live']").waitFor({ timeout: 10000 });
  await mobile.locator("#events").getByText("Governor decision recorded", { exact: false }).waitFor({ timeout: 10000 });
  await mobile.screenshot({ path: join(out, "loom-mobile.png"), fullPage: true });
  await writeFile(join(out, "scenario-result.json"), JSON.stringify({ outcome: "PASS_POSTGRES_BACKED_VIEWER_ONLY", sourceSha: expectedSha, missionId: mission.id, progressEventId: progress.eventId, providerCalls: 0, buildersExecuted: false, completionClaimed: false }, null, 2));
} catch (error) {
  const message = String(error?.message ?? "scenario failed").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED]").replace(/[\r\n\t]+/g, " ").slice(0, 240);
  await writeFile(join(out, "scenario-result.json"), JSON.stringify({ outcome: "FAIL", phase: "controlled_local_browser", errorType: String(error?.name ?? "Error").slice(0, 40), message }, null, 2));
  throw new Error("controlled browser proof failed: " + String(error?.name ?? "Error"));
} finally {
  try { await browser?.close(); } catch {}
  try { await closeServer(); } catch {}
  try { await migrationStore?.close(); } catch {}
  try { await pool?.end(); } catch {}
}
