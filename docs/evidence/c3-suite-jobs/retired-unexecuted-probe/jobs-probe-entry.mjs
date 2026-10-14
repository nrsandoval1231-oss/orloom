import { spawn } from "node:child_process";
import { once } from "node:events";

const sha = async file => {
  const child = spawn("/usr/bin/sha256sum", [file], { cwd: "/work/source", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", CI: "1", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  let output = ""; child.stdout.on("data", value => { output += value; });
  const [code] = await once(child, "exit"); if (code !== 0) throw new Error("cannot hash " + file);
  return output.trim().split(/\s+/, 1)[0];
};
const run = async (label, command, args) => {
  process.stdout.write("ORL-C3-JOBS-PROBE " + label + " START\n");
  const child = spawn(command, args, {
    cwd: "/work/source",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", CI: "1", NODE_ENV: "test" },
    stdio: "inherit"
  });
  const [code, signal] = await once(child, "exit");
  process.stdout.write("ORL-C3-JOBS-PROBE " + label + " END " + (code ?? "UNKNOWN") + "\n");
  if (code !== 0 || signal) process.exitCode = code ?? 1;
  return code === 0 && !signal;
};

process.stdout.write("ORL-C3-JOBS-PROBE dependency-lock-admission START\n");
const admitted = await sha("package.json") === "ce03aab4cd061600bbcf1930380861797b4b8fa7369204b701255df1551820df"
  && await sha("package-lock.json") === "1c9fb3bc8b944f210492b4ae1a2750605d8495f349000464d17afcaa4f9ff1b4";
process.stdout.write("ORL-C3-JOBS-PROBE dependency-lock-admission END " + (admitted ? "0" : "1") + "\n");
if (!admitted) process.exit(1);
if (!(await run("typecheck", "/usr/local/bin/node", ["/opt/orloom-verifier/node_modules/typescript/bin/tsc", "--noEmit"]))) process.exit();
if (!(await run("clean-build", "/usr/local/bin/node", ["/opt/orloom-verifier/node_modules/typescript/bin/tsc"]))) process.exit();
await run("jobs-test", "/usr/local/bin/node", ["--test", "--test-concurrency=1", "dist/tests/jobs.test.js"]);
