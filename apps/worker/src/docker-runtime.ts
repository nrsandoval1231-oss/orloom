import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WorkerLeaseContract } from "../../../packages/contracts/src/worker-protocol.js";
import { checkoutExact, type CheckoutFetchTransport, type ReadOnlyCheckoutToken } from "../../../packages/agents/src/github-checkout.js";
import { assertWorkerScopePath, WorkerProtocolError, type WorkerCheckCommand, type WorkerCheckExecution, type WorkerRuntime, type WorkerWorkspace } from "../../../packages/agents/src/worker.js";
import { ownershipLabelsDigest, type RuntimeIdentity, type RuntimeJournal } from "./runtime-journal.js";

export interface DockerWorkerRuntimeOptions {
  imageRef: string;
  installationId: number;
  checkoutTokens: ReadOnlyCheckoutToken;
  /** In-process runtime-proof seam only; worker main never loads it from config or mission data. */
  checkoutTransport?: CheckoutFetchTransport;
  checks: Record<string, WorkerCheckCommand>;
  scratchRoot?: string;
  dockerPath?: string;
  /** Durable controller-owned runtime intent. When supplied, the exact container
   * identity is persisted before container creation. Startup composition that
   * requires it is a separate activation gate. */
  runtimeJournal?: RuntimeJournal;
}

const maxFileBytes = 1_000_000;
const maxInputBytes = 10_000_000;
const maxOutputDiffBytes = 4_000_000;
const maxCandidateBundleBytes = 20_000_000;
const imageRefPattern = /^(?:ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:|sha256:)[a-f0-9]{64}$/i;
const secretFile = /^(\.env|\.npmrc|\.git-credentials|.*\.(?:pem|key|p12|pfx)|.*(?:credential|secret|private[-_]?key|auth[-_]?token).*)$/i;
const secretBytes = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/;

function validImageRef(imageRef: string) {
  if (!imageRefPattern.test(imageRef)) throw new WorkerProtocolError("Sandbox image must be an operator-pinned immutable image reference");
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, max = 4_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = []; let size = 0;
    child.stdout.on("data", (part: Buffer) => { size += part.length; if (size > max) child.kill(); else out.push(part); });
    child.stderr.on("data", (part: Buffer) => { if (err.reduce((n, b) => n + b.length, 0) < 4_000) err.push(part); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(out).toString("utf8").trim()) : reject(new Error(`Fixed Git operation failed (${code}): ${Buffer.concat(err).toString("utf8").slice(0, 1_000)}`)));
  });
}

function safeRepoPath(root: string, value: string) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\") || value.startsWith("/") || value.split("/").some(x => !x || x === "." || x === ".." || x === ".git")) throw new WorkerProtocolError("Sandbox returned an invalid relative path");
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new WorkerProtocolError("Sandbox path escaped checkout");
  return target;
}

function rejectSecret(relative: string, bytes: Uint8Array) {
  const leaf = relative.split("/").at(-1) ?? relative;
  if (secretFile.test(leaf) && leaf.toLowerCase() !== ".env.example") throw new WorkerProtocolError("Secret-bearing file name is not permitted in worker input");
  if (secretBytes.test(Buffer.from(bytes).toString("utf8"))) throw new WorkerProtocolError("Secret-like material detected in worker input or candidate");
}

async function collectFiles(root: string): Promise<Array<{ path: string; bytesBase64: string; sha256: string }>> {
  const rows: Array<{ path: string; bytesBase64: string; sha256: string }> = [];
  let total = 0;
  const walk = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = safeRepoPath(root, relative);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new WorkerProtocolError("Repository snapshot contains a symlink; transfer fails closed");
      if (info.isDirectory()) { await walk(fullPath, relative); continue; }
      if (!info.isFile() || info.size > maxFileBytes) throw new WorkerProtocolError("Repository snapshot contains an unsupported or oversized file");
      const bytes = await readFile(fullPath);
      rejectSecret(relative, bytes);
      total += bytes.byteLength;
      if (total > maxInputBytes || rows.length >= 5000) throw new WorkerProtocolError("Repository snapshot exceeds worker transfer limits");
      rows.push({ path: relative, bytesBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  };
  await walk(root);
  return rows;
}

interface ContainerInfo { id: string; labels: Record<string, string>; }
export interface DockerContainerControl {
  inspect(id: string): Promise<ContainerInfo | null>;
  remove(id: string): Promise<void>;
}

export function dockerRemoveArgs(id: string): string[] { return ["rm", "--force", id]; }

/** The single source of the ownership labels applied to a worker container.
 * The durable runtime intent binds their digest, so this must stay the only
 * place these labels are constructed. */
export function ownershipLabels(name: string, leaseEpoch: number): Record<string, string> {
  return { "com.orloom.worker-owned": "true", "com.orloom.lease-epoch": String(leaseEpoch), "com.orloom.instance": name };
}

/** Controller-issued lease facts only. The worker derives this identity from the
 * signed lease; it never asserts a run identity of its own. */
export function controllerRunIdFor(lease: WorkerLeaseContract): string {
  return createHash("sha256").update(JSON.stringify([
    lease.protocol, lease.mission.id, lease.slice.id, lease.leaseEpoch,
    lease.planDigest, lease.trustedCheckPolicyDigest, lease.leaseExpiresAt,
  ])).digest("hex");
}

export interface DurableContainerCreation {
  journal: RuntimeJournal;
  identity: RuntimeIdentity;
  name: string;
  imageRef: string;
  labels: Record<string, string>;
  create(): Promise<{ id: string }>;
}

/** Persists controller-owned runtime intent before the container is created and
 * retains the returned container identity afterwards. A create failure leaves
 * the durable intent unresolved on purpose: it is evidence of a possible
 * container, not something to erase. Reconciliation of that evidence is a
 * separate gate. */
export async function createContainerWithDurableIntent(options: DurableContainerCreation): Promise<{ id: string }> {
  const labelsDigest = ownershipLabelsDigest(options.labels);
  await options.journal.recordIntent({ identity: options.identity, name: options.name, imageRef: options.imageRef, labelsDigest });
  const created = await options.create();
  await options.journal.recordCreated(options.identity, created.id, labelsDigest);
  return created;
}

export async function cleanupOwnedContainer(control: DockerContainerControl, id: string, expectedLabels: Record<string, string>): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(id)) throw new WorkerProtocolError("Docker returned an invalid container identity");
  const current = await control.inspect(id);
  if (!current) return;
  if (current.id.toLowerCase() !== id.toLowerCase() || Object.entries(expectedLabels).some(([key, value]) => current.labels[key] !== value)) throw new WorkerProtocolError("Refusing to remove a container without the exact Orloom ownership labels");
  try { await control.remove(id); }
  catch (error) {
    if (await control.inspect(id)) throw new Error("Owned sandbox removal failed and the container remains present", { cause: error });
    return;
  }
  if (await control.inspect(id)) throw new WorkerProtocolError("Owned sandbox container remains present after removal");
}

export async function waitForWritableDrain(stream: NodeJS.WritableStream, signal: AbortSignal, child?: ChildProcessWithoutNullStreams): Promise<void> {
  if (signal.aborted) throw new Error("Sandbox write interrupted before drain");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      child?.removeListener("exit", onExit);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Sandbox input stream closed before drain")); };
    const onAbort = () => { cleanup(); reject(new Error("Sandbox input write was interrupted")); };
    const onExit = () => { cleanup(); reject(new Error("Sandbox process exited before input drain")); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    child?.once("exit", onExit);
  });
}

type InspectedDockerContainer = { Id?: unknown; Config?: { Labels?: unknown }; State?: { Running?: unknown } };

async function dockerCommand(docker: string, configDirectory: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(docker, ["--config", configDirectory, "--host", "unix:///var/run/docker.sock", ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root", DOCKER_CONFIG: configDirectory } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (part: Buffer) => { size += part.length; if (size > 64_000) child.kill("SIGKILL"); else stdout.push(part); });
    child.stderr.on("data", (part: Buffer) => { if (stderr.reduce((n, b) => n + b.length, 0) < 4_000) stderr.push(part); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(`Docker ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1_000)}`));
    });
  });
}

function dockerControl(docker: string, configDirectory: string): DockerContainerControl {
  return {
    async inspect(id) {
      let raw: string;
      try { raw = await dockerCommand(docker, configDirectory, ["inspect", "--format", "{{json .}}", id]); }
      catch (error) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (error instanceof Error && new RegExp(`(?:Error: )?No such (?:object|container): ${escaped}(?:\\s|$)`, "i").test(error.message)) return null;
        throw error;
      }
      let parsed: InspectedDockerContainer;
      try { parsed = JSON.parse(raw) as InspectedDockerContainer; } catch { throw new WorkerProtocolError("Docker returned malformed container inspection data"); }
      if (typeof parsed.Id !== "string" || !parsed.Config?.Labels || typeof parsed.Config.Labels !== "object" || Array.isArray(parsed.Config.Labels)) throw new WorkerProtocolError("Docker inspection omitted container identity or ownership labels");
      return { id: parsed.Id, labels: parsed.Config.Labels as Record<string, string> };
    },
    async remove(id) { await dockerCommand(docker, configDirectory, dockerRemoveArgs(id), 7_000); }
  };
}

class DockerRpc {
  private next = 0;
  private buffer = "";
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private stderr: Buffer[] = [];
  private child: ChildProcessWithoutNullStreams;
  private readonly docker: string;
  private readonly configDirectory: string;
  private readonly containerId: string;
  private readonly ownershipLabels: Record<string, string>;
  private constructor(docker: string, configDirectory: string, child: ChildProcessWithoutNullStreams, containerId: string, ownershipLabels: Record<string, string>) {
    this.child = child;
    this.containerId = containerId;
    this.ownershipLabels = ownershipLabels;
    this.docker = docker;
    this.configDirectory = configDirectory;
    this.child.stdout.on("data", (part: Buffer) => this.onData(part));
    this.child.stderr.on("data", (part: Buffer) => { if (this.stderr.reduce((n, b) => n + b.length, 0) < 8_000) this.stderr.push(part); });
    this.child.stdin.on("error", error => this.failAll(error));
    this.child.once("error", error => this.failAll(error));
    this.child.once("close", code => this.failAll(new Error(`Sandbox exited (${code}); ${Buffer.concat(this.stderr).toString("utf8").slice(0, 1_000)}`)));
  }
  /** The retained Docker container identity for this exact sandbox. */
  get id(): string { return this.containerId; }
  static async launch(docker: string, configDirectory: string, name: string, leaseEpoch: number, imageRef: string): Promise<DockerRpc> {
    validImageRef(imageRef);
    const labels = ownershipLabels(name, leaseEpoch);
    const createArgs = ["create", "--interactive", "--pull=never", `--name=${name}`, ...Object.entries(labels).map(([key, value]) => `--label=${key}=${value}`), "--runtime=runsc", "--network=none", "--read-only", "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700", "--tmpfs=/work:rw,exec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700", "--workdir=/work", "--entrypoint=/usr/local/bin/node", imageRef, "/opt/orloom/sandbox-entry.js"];
    const control = dockerControl(docker, configDirectory);
    let id: string;
    try { id = await dockerCommand(docker, configDirectory, createArgs); }
    catch (error) {
      try {
        const maybeCreated = await control.inspect(name);
        if (maybeCreated) await cleanupOwnedContainer(control, maybeCreated.id, labels);
      } catch (cleanupError) { throw new Error("Docker create outcome and exact-name cleanup are unresolved", { cause: cleanupError }); }
      throw error;
    }
    if (!/^[a-f0-9]{64}$/i.test(id)) {
      try {
        const maybeCreated = await control.inspect(name);
        if (maybeCreated) await cleanupOwnedContainer(control, maybeCreated.id, labels);
      } catch (cleanupError) { throw new Error("Docker create returned an invalid ID and exact-name cleanup is unresolved", { cause: cleanupError }); }
      throw new WorkerProtocolError("Docker create did not return an exact container ID");
    }
    try {
      const inspected = await control.inspect(id);
      if (!inspected || inspected.id.toLowerCase() !== id.toLowerCase() || Object.entries(labels).some(([key, value]) => inspected.labels[key] !== value)) throw new WorkerProtocolError("Created sandbox container failed exact ownership inspection");
      const child = spawn(docker, ["--config", configDirectory, "--host", "unix:///var/run/docker.sock", "start", "--attach", "--interactive", id], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root", DOCKER_CONFIG: configDirectory } });
      return new DockerRpc(docker, configDirectory, child, id, labels);
    } catch (error) {
      await cleanupOwnedContainer(control, id, labels).catch(cleanupError => { throw new Error("Sandbox setup failed and owned container cleanup is unresolved", { cause: cleanupError }); });
      throw error;
    }
  }
  async request<T>(op: string, payload: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    if (signal?.aborted) throw new WorkerProtocolError("Sandbox request cancelled");
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const id = ++this.next;
    const line = `${JSON.stringify({ id: String(id), op, ...payload })}\n`;
    if (Buffer.byteLength(line) > 16_000_000) throw new WorkerProtocolError("Sandbox input message exceeds byte limit");
    const pending = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void pending.catch(() => undefined);
    const abort = () => { this.child.kill("SIGKILL"); this.pending.get(id)?.reject(new Error("Sandbox request was interrupted; effect may be unknown")); };
    boundedSignal.addEventListener("abort", abort, { once: true });
    try {
      if (!this.child.stdin.write(line)) await waitForWritableDrain(this.child.stdin, boundedSignal, this.child);
      return await pending as T;
    } catch (error) {
      this.pending.delete(id);
      if (error instanceof Error && !this.child.killed) this.child.kill("SIGKILL");
      throw new Error("Sandbox RPC was interrupted; operation outcome may be unknown", { cause: error });
    } finally { boundedSignal.removeEventListener("abort", abort); }
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { await this.request("close", {}, undefined, 2_000); } catch { this.child.kill("SIGKILL"); }
      this.child.stdin.end();
      const closed = await this.waitForChildClose(3_000);
      if (!closed) this.child.kill("SIGKILL");
    }
    await cleanupOwnedContainer(dockerControl(this.docker, this.configDirectory), this.containerId, this.ownershipLabels);
  }
  private onData(part: Buffer) {
    this.buffer += part.toString("utf8");
    if (Buffer.byteLength(this.buffer) > 16_000_000) { this.failAll(new Error("Sandbox response exceeded protocol bound")); this.child.kill("SIGKILL"); return; }
    for (;;) {
      const at = this.buffer.indexOf("\n"); if (at < 0) return;
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      try {
        const row = JSON.parse(line) as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
        const id = Number(row.id); const deferred = this.pending.get(id); if (!deferred) continue;
        this.pending.delete(id);
        if (row.ok) deferred.resolve(row.value); else deferred.reject(new Error(typeof row.error === "string" ? row.error : "Sandbox operation failed"));
      } catch { this.failAll(new Error("Sandbox returned malformed protocol data")); this.child.kill("SIGKILL"); return; }
    }
  }
  private failAll(error: Error) { for (const row of this.pending.values()) row.reject(error); this.pending.clear(); }
  private async waitForChildClose(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true;
    return await new Promise(resolve => {
      const finish = (closed: boolean) => {
        clearTimeout(timer);
        this.child.removeListener("close", onClose);
        this.child.removeListener("error", onError);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const onError = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once("close", onClose);
      this.child.once("error", onError);
    });
  }
}

class DockerWorkspace implements WorkerWorkspace {
  private repoCheckout?: Awaited<ReturnType<typeof checkoutExact>>;
  private rpc?: DockerRpc;
  private clientConfig?: string;
  constructor(private readonly lease: WorkerLeaseContract, private readonly options: DockerWorkerRuntimeOptions) {}
  async checkout(repository: string, baseSha: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new WorkerProtocolError("Worker lease deadline reached before checkout");
    if (repository !== this.lease.mission.repository || baseSha !== this.lease.mission.baseSha) throw new WorkerProtocolError("Checkout request does not match the lease identity");
    if (process.platform !== "linux") throw new WorkerProtocolError("Docker runsc broker is available only on the reviewed Linux worker host");
    validImageRef(this.options.imageRef);
    const scratch = this.options.scratchRoot ?? "/var/lib/orloom/worker-jobs";
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    this.repoCheckout = await checkoutExact(this.lease, this.options.installationId, this.options.checkoutTokens, scratch, signal, this.options.checkoutTransport);
    const config = await mkdtemp(path.join(tmpdir(), "orloom-docker-config-"));
    await chmod(config, 0o700);
    this.clientConfig = config;
    const name = `orloom-worker-${this.lease.leaseEpoch}-${randomUUID().slice(0, 8)}`.toLowerCase();
    const docker = this.options.dockerPath ?? "/usr/bin/docker";
    const labels = ownershipLabels(name, this.lease.leaseEpoch);
    let launched: DockerRpc | undefined;
    const create = async (): Promise<{ id: string }> => {
      launched = await DockerRpc.launch(docker, config, name, this.lease.leaseEpoch, this.options.imageRef);
      return { id: launched.id };
    };
    const journal = this.options.runtimeJournal;
    if (journal) {
      await createContainerWithDurableIntent({
        journal,
        identity: { missionId: this.lease.mission.id, sliceId: this.lease.slice.id, leaseEpoch: this.lease.leaseEpoch, controllerRunId: controllerRunIdFor(this.lease) },
        name,
        imageRef: this.options.imageRef,
        labels,
        create,
      });
    } else {
      await create();
    }
    if (!launched) throw new WorkerProtocolError("Sandbox container was not created");
    this.rpc = launched;
    const files = await collectFiles(this.repoCheckout.directory);
    if (files.length === 0) throw new WorkerProtocolError("Exact checkout is empty");
    const policyIds = Object.keys(this.options.checks).sort();
    const allowedIds = [...new Set(this.lease.slice.checks)].sort();
    if (allowedIds.some(id => !policyIds.includes(id))) throw new WorkerProtocolError("Slice requested a check without a trusted sandbox implementation");
    const checks = Object.fromEntries(allowedIds.map(id => [id, this.options.checks[id]]));
    await this.rpc.request("init", { files, checks }, signal);
  }
  private get client() { if (!this.rpc) throw new WorkerProtocolError("Sandbox is not ready"); return this.rpc; }
  async readFile(filePath: string, signal?: AbortSignal) { return (await this.client.request<{ text: string }>("read_file", { path: filePath }, signal)).text; }
  async listFiles(filePath: string, signal?: AbortSignal) { return (await this.client.request<{ files: string[] }>("list_files", { path: filePath }, signal)).files; }
  async replaceText(filePath: string, oldText: string, newText: string, signal?: AbortSignal) { await this.client.request("replace_text", { path: filePath, oldText, newText }, signal); }
  async runCheck(checkId: string, signal: AbortSignal): Promise<WorkerCheckExecution> {
    const timeout = this.options.checks[checkId]?.timeoutSeconds;
    if (!timeout || timeout < 1 || timeout > 300) throw new WorkerProtocolError("Trusted check timeout is not valid");
    const result = await this.client.request<Omit<WorkerCheckExecution, "imageRef">>("run_check", { checkId }, signal, (timeout + 3) * 1000);
    return { ...result, imageRef: this.options.imageRef };
  }
  async commitCandidate(signal?: AbortSignal) {
    if (!this.repoCheckout) throw new WorkerProtocolError("Exact checkout has not been established");
    const snapshot = await this.client.request<{ changed: Array<{ path: string; bytesBase64: string; sha256: string }>; removed: string[] }>("snapshot", {}, signal);
    const touched = [...snapshot.changed.map(x => x.path), ...snapshot.removed];
    if (!touched.length) throw new WorkerProtocolError("Worker produced no candidate changes");
    for (const file of touched) assertWorkerScopePath(file, this.lease.slice.scopes);
    for (const file of snapshot.removed) {
      const target = safeRepoPath(this.repoCheckout.directory, file);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new WorkerProtocolError("Sandbox deletion target is not a regular file");
      await rm(target);
    }
    for (const row of snapshot.changed) {
      const bytes = Buffer.from(row.bytesBase64, "base64");
      if (bytes.toString("base64") !== row.bytesBase64 || bytes.byteLength > maxFileBytes || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new WorkerProtocolError("Sandbox output is malformed or digest-mismatched");
      rejectSecret(row.path, bytes);
      const target = safeRepoPath(this.repoCheckout.directory, row.path);
      const parent = path.dirname(target);
      await mkdir(parent, { recursive: true });
      const realParent = await realpath(parent);
      if (realParent !== this.repoCheckout.directory && !realParent.startsWith(`${this.repoCheckout.directory}${path.sep}`)) throw new WorkerProtocolError("Candidate output parent escaped exact checkout");
      await writeFile(target, bytes, { mode: 0o600 });
    }
    await git(["-C", this.repoCheckout.directory, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Orloom Candidate", "-c", "user.email=worker@orloom.invalid", "diff", "--no-ext-diff", "--check"], this.repoCheckout.directory, this.gitEnv());
    await git(["-C", this.repoCheckout.directory, "-c", "core.hooksPath=/dev/null", "add", "--", ...touched.map(value => `:(literal)${value}`)], this.repoCheckout.directory, this.gitEnv());
    await git(["-C", this.repoCheckout.directory, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Orloom Candidate", "-c", "user.email=worker@orloom.invalid", "commit", "--no-gpg-sign", "-m", "Orloom candidate"], this.repoCheckout.directory, this.gitEnv());
    const candidateSha = await git(["-C", this.repoCheckout.directory, "rev-parse", "HEAD"], this.repoCheckout.directory, this.gitEnv());
    const diff = Buffer.from(await git(["-C", this.repoCheckout.directory, "diff", "--no-ext-diff", "--binary", `${this.lease.mission.baseSha}..${candidateSha}`], this.repoCheckout.directory, this.gitEnv(), maxOutputDiffBytes));
    const bundlePath = path.join(this.repoCheckout.directory, ".orloom-candidate.bundle");
    try {
      const candidateRef = "refs/heads/orloom-candidate";
      await git(["-C", this.repoCheckout.directory, "update-ref", candidateRef, candidateSha], this.repoCheckout.directory, this.gitEnv(), 64_000);
      await git(["-C", this.repoCheckout.directory, "bundle", "create", bundlePath, candidateRef, `^${this.lease.mission.baseSha}`], this.repoCheckout.directory, this.gitEnv(), 64_000);
      await git(["-C", this.repoCheckout.directory, "bundle", "verify", bundlePath], this.repoCheckout.directory, this.gitEnv(), 64_000);
      const heads = await git(["-C", this.repoCheckout.directory, "bundle", "list-heads", bundlePath], this.repoCheckout.directory, this.gitEnv(), 64_000);
      if (!heads.split(/\r?\n/).some(line => line.trim().split(/\s+/)[0]?.toLowerCase() === candidateSha.toLowerCase())) throw new WorkerProtocolError("Candidate Git bundle does not advertise the exact candidate SHA");
      const bundle = await readFile(bundlePath);
      if (bundle.byteLength > maxCandidateBundleBytes) throw new WorkerProtocolError("Candidate Git bundle exceeds evidence limits");
      return { candidateSha, diff, bundle };
    } finally {
      await git(["-C", this.repoCheckout.directory, "update-ref", "-d", "refs/heads/orloom-candidate"], this.repoCheckout.directory, this.gitEnv()).catch(() => undefined);
      await rm(bundlePath, { force: true });
    }
  }
  async close() {
    try { await this.rpc?.close(); } finally {
      if (this.clientConfig) await rm(this.clientConfig, { recursive: true, force: true });
      await this.repoCheckout?.dispose();
    }
  }
  private gitEnv(): NodeJS.ProcessEnv { return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.repoCheckout?.directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }; }
}

export class DockerWorkerRuntime implements WorkerRuntime {
  constructor(private readonly options: DockerWorkerRuntimeOptions) { validImageRef(options.imageRef); }
  async create(lease: WorkerLeaseContract): Promise<WorkerWorkspace> { return new DockerWorkspace(lease, this.options); }
}
