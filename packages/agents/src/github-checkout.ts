import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorkerLeaseContract } from "../../contracts/src/worker-protocol.js";

export interface ReadOnlyCheckoutToken { createCheckoutToken(installationId: number, repository: string): Promise<string>; }
export interface ExactCheckout { directory: string; baseSha: string; dispose(): Promise<void>; }
export interface CheckoutFetchTransport {
  /** In-process test/runtime seam. It supplies only a source to the fixed fetch operation; it cannot choose refs or Git flags. */
  fetchExact(request: { repository: string; baseSha: string; fetch(source: string): Promise<void> }): Promise<void>;
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Git operation cancelled by lease deadline")); return; }
    const child = spawn("git", args, { cwd, env, shell: false, detached: process.platform === "linux", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0;
    const stop = () => {
      if (process.platform === "linux" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group already exited */ } }
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 30_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => { size += data.length; if (size <= 64_000) out.push(data); else child.kill(); });
    child.stderr.on("data", (data: Buffer) => { if (err.reduce((n, x) => n + x.length, 0) < 8_000) err.push(data); });
    child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(error); });
    child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", stop); code === 0 ? resolve(Buffer.concat(out).toString("utf8").trim()) : reject(new Error(`Git exited ${code}; ${Buffer.concat(err).toString("utf8").slice(0, 2_000)}`)); });
  });
}

function askpassFile(token: string, directory: string): { file: string; envKey: string } {
  if (!token || /[\r\n\0]/.test(token)) throw new Error("Invalid checkout token");
  const file = path.join(directory, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  return { file, envKey: "ORLOOM_EPHEMERAL_GITHUB_TOKEN" };
}

/** Fetches one exact commit over HTTPS; repository hooks, LFS, submodules, and inherited Git auth are disabled. */
export async function checkoutExact(lease: WorkerLeaseContract, installationId: number, tokens: ReadOnlyCheckoutToken, parent = tmpdir(), signal?: AbortSignal, transport?: CheckoutFetchTransport): Promise<ExactCheckout> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lease.mission.repository) || !/^[a-f0-9]{40}$/i.test(lease.mission.baseSha)) throw new Error("Invalid immutable checkout identity");
  const privateRoot = await mkdtemp(path.join(parent, "orloom-checkout-"));
  await chmod(privateRoot, 0o700).catch(() => undefined);
  const directory = path.join(privateRoot, "repo");
  try {
  let askpassPath: string | undefined;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: privateRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0"
  };
    await runGit(["init", "--quiet", directory], privateRoot, env, signal);
    const git = (args: string[]) => runGit(["-C", directory, "-c", "credential.helper=", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false", "-c", "submodule.recurse=false", ...args], privateRoot, env, signal);
    const origin = `https://github.com/${lease.mission.repository}.git`;
    await git(["remote", "add", "origin", origin]);
    const fetchExact = async (source: string) => {
      if (signal?.aborted) throw new Error("Checkout cancelled by lease deadline");
      await git(["-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", source, lease.mission.baseSha]);
    };
    if (transport) {
      await transport.fetchExact({ repository: lease.mission.repository, baseSha: lease.mission.baseSha, fetch: fetchExact });
    } else {
      const token = await tokens.createCheckoutToken(installationId, lease.mission.repository.split("/")[1]!);
      if (signal?.aborted) throw new Error("Checkout cancelled by lease deadline");
      const askpass = askpassFile(token, privateRoot);
      askpassPath = askpass.file;
      const script = process.platform === "win32"
        ? "@echo off\r\necho %* | findstr /i username >nul && (echo x-access-token) || (echo %ORLOOM_EPHEMERAL_GITHUB_TOKEN%)\r\n"
        : "#!/bin/sh\ncase \"$1\" in *[Uu]sername*) printf '%s\\n' x-access-token ;; *) printf '%s\\n' \"$ORLOOM_EPHEMERAL_GITHUB_TOKEN\" ;; esac\n";
      await writeFile(askpass.file, script, { mode: 0o700 });
      env.GIT_ASKPASS = askpass.file;
      env.GCM_INTERACTIVE = "Never";
      env[askpass.envKey] = token;
      await fetchExact("origin");
    }
    await git(["checkout", "--detach", "FETCH_HEAD"]);
    const actual = await git(["rev-parse", "HEAD"]);
    if (actual.toLowerCase() !== lease.mission.baseSha.toLowerCase()) throw new Error("Fetched commit did not match the immutable base SHA");
    if (askpassPath) await rm(askpassPath, { force: true });
    return {
      directory,
      baseSha: actual,
      async dispose() { await rm(privateRoot, { recursive: true, force: true }); }
    };
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
}
