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

/** Maps an injected launcher-process result to check status; only an exact clean exit/marker match is determinate. */
export function classifyLauncherOutput(stdout: string, processResult: LauncherProcessResult, maxLogBytes: number): SandboxResult {
  const markers = stdout.split(/\r?\n/).filter((line) => line.startsWith("ORLOOM-RESULT:"));
  const unknown = (): ReturnType<typeof classifyLauncherOutput> => ({ sandboxId: "unavailable", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: true, timedOut: true, launcherExitCode: processResult.exitCode, ...(processResult.signal ? { launcherSignal: processResult.signal } : {}), launcherTimedOut: processResult.timedOut === true || processResult.killed === true, launcherTruncated: processResult.truncated === true });
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
        const completed = await exec("/bin/bash", [this.options.launcherScript, name], {
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
