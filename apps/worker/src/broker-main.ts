import { lstat, readFile, stat } from "node:fs/promises";
import { createGitHubAppAdapter, createR2ArtifactStore } from "../../../packages/adapters/src/providers.js";
import { loadConfig } from "../../../packages/config/src/config.js";
import { R2WorkerProgressSink, DeepSeekHttpClient, executeLease, HttpControlPlane, WorkerProtocolError, type WorkerCheckCommand } from "../../../packages/agents/src/worker.js";
import type { WorkerPricingSnapshot } from "../../../packages/agents/src/worker.js";
import { DockerWorkerRuntime } from "./docker-runtime.js";
import { acquireWorkerServiceLock } from "./service-lock.js";
import { FileRuntimeJournal } from "./runtime-journal.js";
import { runWorkerPollPool } from "./poll-pool.js";

async function secret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000 || (process.platform === "linux" && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())))) throw new WorkerProtocolError(`${name}_FILE must be a private regular file owned by the worker service account`);
    const value = (await readFile(file, "utf8")).trim();
    if (!value) throw new WorkerProtocolError(`${name} is empty`);
    return value;
  }
  const value = process.env[name]?.trim();
  if (!value) throw new WorkerProtocolError(`${name} or ${name}_FILE is required`);
  return value;
}

async function jsonFile<T>(name: string): Promise<T> {
  const file = process.env[name];
  if (!file) throw new WorkerProtocolError(`${name} must point to an operator-owned policy file`);
  const info = await stat(file);
  if (!info.isFile() || info.size > 256_000) throw new WorkerProtocolError(`${name} must be a regular file under 256 KiB`);
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function checkPolicy(value: unknown, allowed: string[]): Record<string, WorkerCheckCommand> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerProtocolError("Trusted check command policy is malformed");
  const rows = value as Record<string, unknown>;
  if (Object.keys(rows).sort().join("\n") !== [...allowed].sort().join("\n")) throw new WorkerProtocolError("Trusted check command IDs do not match the configured policy IDs");
  for (const [id, raw] of Object.entries(rows)) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkerProtocolError("Invalid trusted check command entry");
    const command = raw as WorkerCheckCommand;
    if (typeof command.executable !== "string" || !/^(node|npm|pnpm|python3|pytest|ruff|go|cargo)$/.test(command.executable.split(/[\\/]/).at(-1) ?? "") || !Array.isArray(command.args) || command.args.length > 64 || command.args.some(arg => typeof arg !== "string" || arg.length > 500) || !Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 300) throw new WorkerProtocolError("Invalid trusted check command fields");
  }
  return rows as Record<string, WorkerCheckCommand>;
}

async function bootstrap() {
  const config = loadConfig(process.env);
  const controlUrl = process.env.ORLOOM_WORKER_CONTROL_URL?.trim();
  const installationId = Number(process.env.ORLOOM_GITHUB_INSTALLATION_ID ?? "0");
  const imageRef = process.env.ORLOOM_WORKER_SANDBOX_IMAGE_REF?.trim() ?? "";
  const maxToolCalls = Number(process.env.ORLOOM_WORKER_MAX_TOOL_CALLS ?? "0");
  const concurrency = Number(process.env.ORLOOM_WORKER_CONCURRENCY ?? "1");
  const pricing = await jsonFile<WorkerPricingSnapshot>("ORLOOM_WORKER_PRICING_SNAPSHOT_FILE");
  const checks = checkPolicy(await jsonFile("ORLOOM_WORKER_CHECK_COMMANDS_FILE"), config.trustedCheckPolicy ?? []);
  if (!controlUrl || !Number.isSafeInteger(installationId) || installationId < 1 || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new WorkerProtocolError("Worker control, GitHub installation, tool, concurrency, or sandbox config is incomplete");
  const github = createGitHubAppAdapter({ appId: Number(await secret("ORLOOM_GITHUB_APP_ID")), privateKey: await secret("ORLOOM_GITHUB_PRIVATE_KEY") });
  const artifacts = createR2ArtifactStore({ accountId: await secret("ORLOOM_R2_ACCOUNT_ID"), accessKeyId: await secret("ORLOOM_R2_ACCESS_KEY_ID"), secretAccessKey: await secret("ORLOOM_R2_SECRET_ACCESS_KEY"), bucket: await secret("ORLOOM_R2_BUCKET") });
  const control = new HttpControlPlane(controlUrl, await secret("ORLOOM_WORKER_TOKEN"));
  const provider = new DeepSeekHttpClient(await secret("ORLOOM_DEEPSEEK_API_KEY"));
  const runtimeJournal = await FileRuntimeJournal.openOperational("/var/lib/orloom/worker-runtime");
  const runtime = new DockerWorkerRuntime({ imageRef, installationId, checkoutTokens: github, checks, runtimeJournal });
  // Dedicated service ownership is required: reconcile interrupted containers
  // before the first claim, never while another broker owns active work.
  await runtime.reconcileInterrupted();
  const progress = new R2WorkerProgressSink(artifacts);
  const options = { allowedModels: config.workerAllowedModels ?? [], allowedProviders: config.workerAllowedProviders ?? [], trustedChecks: config.trustedCheckPolicy ?? [], trustedCheckPolicyDigest: config.trustedCheckPolicyDigest ?? "", trustedCheckCommands: checks, sandboxImageRef: imageRef, maxToolCalls, pricing };
  const checkIds = Object.fromEntries((config.trustedCheckPolicy ?? []).map(id => [id, [id]]));
  return { control, provider, runtime, artifacts, progress, checks, checkIds, options, concurrency };
}

async function main() {
  const serviceLock = await acquireWorkerServiceLock();
  try {
    const deps = await bootstrap();
    const shutdown = new AbortController();
    process.once("SIGTERM", () => shutdown.abort());
    process.once("SIGINT", () => shutdown.abort());
    await runWorkerPollPool({
      concurrency: deps.concurrency,
      pollIntervalMs: 3_000,
      signal: shutdown.signal,
      claim: () => deps.control.claim(),
      execute: lease => executeLease(lease, { control: deps.control, provider: deps.provider, runtime: deps.runtime, evidence: deps.artifacts, progress: deps.progress, checks: deps.checkIds, options: deps.options }),
      onPollError: () => process.stderr.write("Orloom worker poll failed; no job was acknowledged.\n")
    });
  } finally { await serviceLock.release(); }
}

main().catch(() => {
  process.stderr.write("Orloom worker startup blocked; details suppressed.\n");
  process.exitCode = 1;
});
