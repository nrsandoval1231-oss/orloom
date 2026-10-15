import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import test from "node:test";

test("documented blank environment template starts the local owner UI with verification disabled", async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const template = parseEnv(await readFile(".env.example", "utf8"));
  const child = spawn(process.execPath, ["dist/apps/control-plane/src/main.js"], {
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...template, ORLOOM_SESSION_TOKEN: "startup-fixture-owner", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "", stderr = "";
  child.stderr.on("data", part => { stderr += String(part); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("Local template startup did not become ready within 10s")), 10_000);
      child.stdout.on("data", part => { stdout += String(part); if (stdout.includes(`listening on 127.0.0.1:${port}`)) resolve(); });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Local template startup exited ${code}: ${stderr}`)));
    });
    const response = await fetch(`http://127.0.0.1:${port}/`, {signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Local mission control plane\. Worker execution is disabled by default\./);
    assert.equal(stderr, "");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  }
});
