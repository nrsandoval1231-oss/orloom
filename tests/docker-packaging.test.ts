import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

test("control-plane Docker build stage includes and runs its asset-copy helper", async () => {
  const stage = await mkdtemp(join(tmpdir(), "orloom-docker-build-"));
  try {
    const dockerfile = await readFile("apps/control-plane/Dockerfile", "utf8");
    const buildStage = dockerfile.split(/^FROM /m)[1]!;
    // Stage only the declared COPY inputs before the build, never the whole checkout.
    for (const line of buildStage.split("RUN npm run build")[0]!.split(/\r?\n/)) {
      if (!line.startsWith("COPY ")) continue;
      const parts = line.slice(5).trim().split(/\s+/);
      const target = parts.pop()!;
      assert(parts.length > 0 && !parts.some(p => p.startsWith("--")), "update the stage fixture for new COPY syntax");
      for (const source of parts) {
        const destination = target === "./" ? join(stage, basename(source)) : resolve(stage, target);
        await cp(source, destination, { recursive: true });
      }
    }
    const pkg = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
    assert.match(pkg.scripts.build, /node scripts\/copy-git-askpass\.mjs/);
    execFileSync(process.execPath, ["scripts/copy-git-askpass.mjs"], { cwd: stage, stdio: "pipe" });
    for (const name of ["git-askpass.sh", "git-askpass.cmd", "git-askpass.ps1"]) {
      const output = join(stage, "dist/packages/integration/src", name);
      assert.deepEqual(await readFile(output), await readFile(join("packages/integration/src", name)));
      if (name.endsWith(".sh") && process.platform !== "win32") assert((await stat(output)).mode & 0o111);
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
});
