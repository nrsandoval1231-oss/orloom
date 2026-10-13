import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckPolicy } from "./policy.js";
import type { InputBundle } from "./repository.js";
import type { SandboxLauncher, SandboxResult } from "./runner.js";

const exec = promisify(execFile);
function checkName(value: string): void {
  if (!/^[^/\\\0]+$/.test(value) || value === "." || value === "..") throw new Error("unsafe extracted path");
}
async function makePrivateDir(directory: string, mode = 0o700): Promise<void> {
  const parsed = path.parse(directory); let cursor = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { await mkdir(cursor, { mode }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("staging path contains a symlink or non-directory");
  }
  await chmod(directory, mode);
}

export interface LauncherProcessResult { exitCode: number | null; signal?: string | null; timedOut?: boolean; killed?: boolean; truncated?: boolean; stderr?: string; }

const DIAGNOSTIC_PREFIX = "ORLOOM-DIAG:v1:";
const DIAGNOSTIC_BYTES_MAX = 4096, DIAGNOSTIC_FRAMES_MAX = 16, DIAGNOSTIC_LINE_MAX = 512;
const DIAGNOSTIC_STAGES = ["dependency-lock-admission", "typecheck", "clean-build", "test-discovery", "node-tests", "foundation-validation", "offline-security-policy"] as const;

/** Retains only complete, bounded fixed-schema telemetry; frames never classify a check. */
export function retainSuiteDiagnostics(stdout: string): Buffer {
  if (Buffer.byteLength(stdout) > 256 * 1024) return Buffer.alloc(0);
  const lines = stdout.split("\n"), completeCount = stdout.endsWith("\n") ? lines.length - 1 : Math.max(0, lines.length - 1);
  const kept: string[] = []; let bytes = 0, frames = 0, nextStage = 0, openStage: string | undefined, halted = false;
  for (let index = 0; index < completeCount; index++) {
    if (halted) break;
    const line = lines[index]!.endsWith("\r") ? lines[index]!.slice(0, -1) : lines[index]!;
    if (!line.startsWith(DIAGNOSTIC_PREFIX) || line.length > DIAGNOSTIC_LINE_MAX || frames >= DIAGNOSTIC_FRAMES_MAX) continue;
    const encoded = line.slice(DIAGNOSTIC_PREFIX.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) continue;
    let parsed: unknown;
    try {
      const raw = Buffer.from(encoded, "base64");
      if (raw.toString("base64") !== encoded) continue;
      parsed = JSON.parse(raw.toString("utf8"));
    } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const frame = parsed as Record<string, unknown>;
    const phase = frame.phase;
    const keys = Object.keys(frame).sort().join(",");
    const common = frame.version === "orloom.suite-diagnostics.v1"
      && typeof frame.stage === "string" && Number.isSafeInteger(frame.elapsedMs)
      && (frame.elapsedMs as number) >= 0 && (frame.elapsedMs as number) <= 60_000;
    if (!common) continue;
    const stage = frame.stage as string;
    if (phase === "start" && keys === "elapsedMs,phase,stage,version" && openStage === undefined
      && stage === DIAGNOSTIC_STAGES[nextStage]) {
      openStage = stage;
    } else if (phase === "end" && keys === "elapsedMs,outcome,phase,stage,version" && openStage === stage
      && typeof frame.outcome === "string" && ["pass", "fail", "unknown"].includes(frame.outcome)) {
      openStage = undefined; nextStage++; halted = frame.outcome !== "pass";
    } else continue;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (bytes + lineBytes > DIAGNOSTIC_BYTES_MAX) break;
    kept.push(`${line}\n`); bytes += lineBytes; frames++;
  }
  return Buffer.from(kept.join(""), "utf8");
}

/** Maps an injected launcher-process result to check status; only an exact clean exit/marker match is determinate. */
export function classifyLauncherOutput(stdout: string, processResult: LauncherProcessResult, maxLogBytes: number): SandboxResult {
  const markers = stdout.split(/\r?\n/).filter((line) => line.startsWith("ORLOOM-RESULT:"));
  const unknown = (): ReturnType<typeof classifyLauncherOutput> => ({ sandboxId: "unavailable", exitCode: null, stdout: retainSuiteDiagnostics(stdout), stderr: Buffer.alloc(0), truncated: true, timedOut: true, launcherExitCode: processResult.exitCode, ...(processResult.signal ? { launcherSignal: processResult.signal } : {}), launcherTimedOut: processResult.timedOut === true || processResult.killed === true, launcherTruncated: processResult.truncated === true });
  if (markers.length !== 1 || processResult.exitCode === null || processResult.signal || processResult.timedOut || processResult.killed || processResult.truncated || processResult.stderr || ![0, 1].includes(processResult.exitCode)) return unknown();
  try {
    const parsed = JSON.parse(Buffer.from(markers[0]!.slice("ORLOOM-RESULT:".length), "base64").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "exitCode,stderr,stderrBytes,stdout,stdoutBytes,truncated" || ![0, 1].includes(parsed.exitCode as number) || parsed.exitCode !== processResult.exitCode || parsed.truncated !== false || typeof parsed.stdoutBytes !== "number" || typeof parsed.stderrBytes !== "number" || typeof parsed.stdout !== "string" || typeof parsed.stderr !== "string" || parsed.stdoutBytes < 0 || parsed.stderrBytes < 0) return unknown();
    const out = Buffer.from(parsed.stdout, "base64"), err = Buffer.from(parsed.stderr, "base64");
    if (out.length > maxLogBytes || err.length > maxLogBytes || out.length !== parsed.stdoutBytes || err.length !== parsed.stderrBytes) return unknown();
    return { sandboxId: "launcher-result", exitCode: parsed.exitCode as 0 | 1, stdout: out, stderr: err, truncated: false, timedOut: false, launcherExitCode: processResult.exitCode, launcherTimedOut: false, launcherTruncated: false };
  } catch { return unknown(); }
}

/** Host-side adapter for the fixed runsc launcher. Requires Linux and the protected root service account. */
export class LocalRunscLauncher implements SandboxLauncher {
  constructor(private readonly options: { image: string; launcherScript: string; inputRoot?: string; outputRoot?: string; timeoutMs?: number }) {
    if (!/^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64})$/.test(options.image)) throw new Error("verifier image must be pinned by immutable digest or local image ID");
    if (!path.isAbsolute(options.launcherScript)) throw new Error("launcher script path must be absolute");
  }

  async launch(policy: CheckPolicy, bundle: InputBundle): Promise<SandboxResult> {
    if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("runsc launcher requires the protected Linux root service");
    const name = `orloom-verifier-${randomUUID()}`;
    const inBase = this.options.inputRoot ?? "/run/orloom-verifier-input";
    if (inBase !== "/run/orloom-verifier-input") throw new Error("launcher paths are fixed by host policy");
    await makePrivateDir(inBase);
    const input = path.join(inBase, name);
    await mkdir(input, { mode: 0o700 });
    try {
      const total = [...bundle.files.values()].reduce((n, b) => n + b.length, bundle.manifest.length);
      if (total > policy.maxInputBytes || bundle.manifest.length > 1_048_576) throw new Error("sandbox input exceeds bounds");
      await writeFile(path.join(input, "manifest.json"), bundle.manifest, { flag: "wx", mode: 0o444 });
      const source = path.join(input, "source"); await mkdir(source, { mode: 0o555 });
      const dirs = new Set<string>();
      for (const [namePath, bytes] of bundle.files) {
        const parts = namePath.split("/"); parts.forEach(checkName);
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
        const parent = path.join(source, ...parts.slice(0, -1));
        await mkdir(parent, { recursive: true, mode: 0o555 });
        await writeFile(path.join(source, ...parts), bytes, { flag: "wx", mode: 0o444 });
      }
      for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await chmod(path.join(source, ...dir.split("/")), 0o555);
      await chmod(source, 0o555); await chmod(input, 0o555);
      let stdout = "", launcherStderr = "";
      let launcherExitCode: number | null = null, launcherSignal: string | undefined, launcherTimedOut = false, launcherKilled = false, launcherTruncated = false;
      try {
        const completed = await exec("/bin/bash", [this.options.launcherScript, name, policy.id], {
          timeout: this.options.timeoutMs ?? policy.timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true,
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", ORLOOM_VERIFIER_IMAGE: this.options.image, HOME: "/root", LANG: "C" },
        });
        stdout = completed.stdout; launcherStderr = completed.stderr; launcherExitCode = 0;
      } catch (error) {
        const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string; killed?: boolean; code?: string | number };
        stdout = typeof failed.stdout === "string" ? failed.stdout : ""; launcherStderr = typeof failed.stderr === "string" ? failed.stderr : "";
        launcherExitCode = typeof failed.code === "number" ? failed.code : null; launcherSignal = failed.signal; launcherKilled = failed.killed === true;
        launcherTimedOut = failed.killed === true || failed.code === "ETIMEDOUT";
        launcherTruncated = failed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      }
      const classified = classifyLauncherOutput(stdout, { exitCode: launcherExitCode, ...(launcherSignal ? { signal: launcherSignal } : {}), timedOut: launcherTimedOut, killed: launcherKilled, truncated: launcherTruncated, stderr: launcherStderr }, policy.maxLogBytes);
      return { ...classified, sandboxId: name };
    } finally {
      // Names are generated locally and both bases are fixed operator paths.
      await rm(input, { recursive: true, force: true });
    }
  }
}
