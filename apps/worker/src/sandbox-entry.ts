import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = "/work/tree";
const maxFileBytes = 1_000_000;
const maxOutputBytes = 64_000;
const maxRequestBytes = 16_000_000;
type Check = { executable: string; args: string[]; timeoutSeconds: number };
const originals = new Map<string, string>();
let checks: Record<string, Check> = {};
let initialized = false;

function validRelative(value: unknown) {
  if (typeof value !== "string" || value.length > 500 || !value || value.includes("\\") || value.startsWith("/") || value.split("/").some(x => !x || x === "." || x === ".." || x === ".git")) throw new Error("invalid workspace path");
  return value;
}

async function safePath(relative: unknown) {
  const key = validRelative(relative);
  const target = path.join(root, key);
  if (!target.startsWith(`${root}/`)) throw new Error("workspace path escaped");
  let cursor = root;
  for (const part of key.split("/")) {
    cursor = path.join(cursor, part);
    try { const info = await lstat(cursor); if (info.isSymbolicLink()) throw new Error("symlink paths are disabled"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const existing = await realpath(path.dirname(target)).catch(() => path.dirname(target));
  if (existing !== root && !existing.startsWith(`${root}/`)) throw new Error("workspace path escaped");
  return { key, target };
}

async function filesUnder(relative = ""): Promise<string[]> {
  const dir = relative ? (await safePath(relative)).target : root;
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const { target } = await safePath(name);
    if (entry.isDirectory()) output.push(...await filesUnder(name));
    else if (entry.isFile()) output.push(name);
    else throw new Error("unsupported file type in workspace");
  }
  return output;
}

function parseLine(line: string) { if (Buffer.byteLength(line) > maxRequestBytes) throw new Error("request exceeds sandbox protocol limit"); return JSON.parse(line) as Record<string, unknown>; }
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

async function init(payload: Record<string, unknown>) {
  if (initialized || !Array.isArray(payload.files) || !payload.checks || typeof payload.checks !== "object" || Array.isArray(payload.checks)) throw new Error("invalid or duplicate sandbox initialization");
  await mkdir(root, { recursive: true });
  let total = 0;
  for (const item of payload.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid input file");
    const row = item as { path?: unknown; bytesBase64?: unknown; sha256?: unknown };
    const { key, target } = await safePath(row.path);
    if (typeof row.bytesBase64 !== "string" || !/^[a-f0-9]{64}$/.test(String(row.sha256))) throw new Error("invalid input digest");
    const bytes = Buffer.from(row.bytesBase64, "base64");
    total += bytes.byteLength;
    if (bytes.byteLength > maxFileBytes || total > 10_000_000 || sha(bytes) !== row.sha256) throw new Error("input file is oversized or has a digest mismatch");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    originals.set(key, String(row.sha256));
  }
  for (const [id, value] of Object.entries(payload.checks as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid check policy entry");
    const check = value as Check;
    if (typeof check.executable !== "string" || !/^(node|npm|pnpm|python3|pytest|ruff|go|cargo)$/.test(check.executable) || !Array.isArray(check.args) || check.args.length > 64 || check.args.some(x => typeof x !== "string" || x.length > 500 || /(?:token|secret|password|api[_-]?key)/i.test(x)) || !Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 300) throw new Error("unsafe trusted check definition");
    checks[id] = { executable: check.executable, args: check.args, timeoutSeconds: check.timeoutSeconds };
  }
  initialized = true;
  return { initialized: true, fileCount: originals.size, bytes: total };
}

async function runCheck(id: unknown) {
  if (typeof id !== "string" || !checks[id]) throw new Error("check ID is not in the trusted policy");
  const check = checks[id]!;
  return await new Promise<{ exitCode: number; output: string; outputSha256: string; commandDigest: string; durationMs: number }>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(check.executable, check.args, { cwd: root, shell: false, detached: process.platform === "linux", windowsHide: true, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", CI: "1", npm_config_offline: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const killGroup = () => { if (process.platform === "linux" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ } } else child.kill("SIGKILL"); };
    const timer = setTimeout(killGroup, check.timeoutSeconds * 1000);
    const capture = (part: Buffer) => { size += part.length; if (size <= maxOutputBytes) chunks.push(part); else killGroup(); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", error => { clearTimeout(timer); killGroup(); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); killGroup();
      const output = Buffer.concat(chunks);
      const commandDigest = createHash("sha256").update(JSON.stringify({ executable: check.executable, args: check.args, timeoutSeconds: check.timeoutSeconds })).digest("hex");
      resolve({ exitCode: code ?? 255, output: output.toString("utf8").slice(0, maxOutputBytes), outputSha256: sha(output), commandDigest, durationMs: Math.max(0, Date.now() - startedAt) });
    });
  });
}

async function snapshot() {
  const currentFiles = await filesUnder();
  const changed: Array<{ path: string; bytesBase64: string; sha256: string }> = [];
  for (const key of currentFiles) {
    const { target } = await safePath(key);
    const info = await lstat(target);
    if (!info.isFile() || info.size > maxFileBytes) throw new Error("unsupported or oversized output file");
    const bytes = await readFile(target);
    const hash = sha(bytes);
    if (originals.get(key) !== hash) changed.push({ path: key, bytesBase64: bytes.toString("base64"), sha256: hash });
  }
  const removed = [...originals.keys()].filter(key => !currentFiles.includes(key));
  return { changed, removed };
}

async function dispatch(request: Record<string, unknown>) {
  if (request.op === "init") return init(request);
  if (!initialized) throw new Error("sandbox has not been initialized");
  if (request.op === "read_file") { const { target } = await safePath(request.path); const bytes = await readFile(target); if (bytes.byteLength > maxFileBytes) throw new Error("file exceeds limit"); return { text: bytes.toString("utf8") }; }
  if (request.op === "list_files") { const files = await filesUnder(typeof request.path === "string" ? request.path : ""); return { files: files.slice(0, 500) }; }
  if (request.op === "replace_text") {
    const { key, target } = await safePath(request.path);
    const oldText = request.oldText, newText = request.newText;
    if (typeof oldText !== "string" || typeof newText !== "string" || !oldText || oldText.length > 8_000 || newText.length > 8_000) throw new Error("invalid text patch");
    const current = await readFile(target, "utf8");
    if (current.split(oldText).length !== 2) throw new Error("patch context must match exactly once");
    await writeFile(target, current.replace(oldText, newText), { mode: 0o600 });
    return { updated: true, path: key };
  }
  if (request.op === "run_check") return runCheck(request.checkId);
  if (request.op === "snapshot") return snapshot();
  if (request.op === "close") { await rm(root, { recursive: true, force: true }); return { closed: true }; }
  throw new Error("unknown sandbox operation");
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line) continue;
  let id: string | undefined;
  try {
    const request = parseLine(line); id = typeof request.id === "string" ? request.id : undefined;
    const value = await dispatch(request);
    process.stdout.write(`${JSON.stringify({ id, ok: true, value })}\n`);
    if (request.op === "close") break;
  } catch (error) {
    const message = error instanceof Error ? error.message : "sandbox_error";
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: message.slice(0, 500) })}\n`);
  }
}
