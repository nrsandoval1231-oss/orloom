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
      let stdout = "";
      try {
        ({ stdout } = await exec("/bin/bash", [this.options.launcherScript, name], {
          timeout: this.options.timeoutMs ?? policy.timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true,
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", ORLOOM_VERIFIER_IMAGE: this.options.image, HOME: "/root", LANG: "C" },
        }));
      } catch (error) {
        const failed = error as NodeJS.ErrnoException & { stdout?: string };
        if (typeof failed.stdout !== "string" || !failed.stdout.includes("ORLOOM-RESULT:")) throw error;
        stdout = failed.stdout;
      }
      const marker = stdout.split(/\r?\n/).find((line) => line.startsWith("ORLOOM-RESULT:"));
      if (!marker) throw new Error("sandbox result is missing");
      const result = JSON.parse(Buffer.from(marker.slice("ORLOOM-RESULT:".length), "base64").toString("utf8")) as Record<string, unknown>;
      if (Object.keys(result).sort().join(",") !== "exitCode,stderr,stderrBytes,stdout,stdoutBytes,truncated" || typeof result.truncated !== "boolean" || typeof result.stdoutBytes !== "number" || typeof result.stderrBytes !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stdoutBytes < 0 || result.stderrBytes < 0) throw new Error("sandbox result metadata is invalid");
      const stdoutBytes = Buffer.from(result.stdout, "base64"), stderrBytes = Buffer.from(result.stderr, "base64");
      if (stdoutBytes.length > policy.maxLogBytes || stderrBytes.length > policy.maxLogBytes || stdoutBytes.length !== Math.min(result.stdoutBytes, policy.maxLogBytes) || stderrBytes.length !== Math.min(result.stderrBytes, policy.maxLogBytes)) throw new Error("sandbox logs are missing or truncated");
      const exitCode = result.exitCode === 0 || result.exitCode === 1 ? result.exitCode : null;
      return { sandboxId: name, exitCode, stdout: stdoutBytes, stderr: stderrBytes, truncated: result.truncated === true, timedOut: exitCode === null };
    } finally {
      // Names are generated locally and both bases are fixed operator paths.
      await rm(input, { recursive: true, force: true });
    }
  }
}
