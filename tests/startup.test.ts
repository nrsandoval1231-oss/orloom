import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Node env-file startup loads local token and starts the real control-plane entrypoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orloom-startup-"));
  const envPath = join(dir, "local.env");
  const secret = "test-only-startup-token-not-a-real-credential";
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  await writeFile(envPath, `ORLOOM_MODE=local\nORLOOM_SESSION_TOKEN=${secret}\nPORT=${port}\n`);
  const child = spawn(process.execPath, [`--env-file-if-exists=${envPath}`, "dist/apps/control-plane/src/main.js"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += String(chunk); });
  child.stderr.on("data", chunk => { logs += String(chunk); });
  try {
    let health: Response | undefined;
    // A cold ESM graph on a mounted checkout can exceed two seconds. Keep a
    // finite readiness deadline, and fail promptly when the child exits.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { health = await fetch(`http://127.0.0.1:${port}/health`); if (health.ok) break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert(health?.ok, `control plane did not start: ${logs.replaceAll(secret, "[redacted]")}`);
    const session = await fetch(`http://127.0.0.1:${port}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: secret }) });
    assert.equal(session.status, 204);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
