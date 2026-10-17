import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DockerWorkerRuntime } from "../apps/worker/src/docker-runtime.js";
import { DeepSeekHttpClient, executeLease, type WorkerOptions, type WorkerWorkspace } from "../packages/agents/src/worker.js";
import type { WorkerLeaseContract, WorkerResult } from "../packages/contracts/src/worker-protocol.js";

const model = "deepseek-chat";
const trustedChecks = ["node-repo-suite-v1"];
const policyDigest = createHash("sha256").update(JSON.stringify(trustedChecks)).digest("hex");
const imageRef = `sha256:${"d".repeat(64)}`;
const pricing = { model, version: "fixture-v1", source: "operator test fixture", capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), inputCentsPerMillion: 10, outputCentsPerMillion: 10, reasoningCentsPerMillion: 10, safetyMultiplier: 1.2 };
const lease: WorkerLeaseContract = {
  protocol: "orloom.worker-lease.v1",
  mission: { id: "mission-optional-check", repository: "owner/repo", baseSha: "a".repeat(40), objective: "bounded optional check test", acceptance: ["preserve mandatory final verification"] },
  slice: { id: "slice-optional-check", objective: "build one candidate", dependencies: [], owner: "builder", scopes: ["src/**"], checks: trustedChecks },
  capacitySlot: 1, leaseEpoch: 1, leaseToken: "lease-fixture", capabilityToken: "capability-fixture", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  trustedCheckPolicyDigest: policyDigest, planDigest: "b".repeat(64),
  executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens: 10_000, maxOutputTokens: 100, maxWallSeconds: 30, allowedProviders: ["deepseek"], allowedModels: [model] }
};

test("DeepSeek completion omits run_check when no worker-local command is configured", async () => {
  const toolLists: string[][] = [];
  const client = new DeepSeekHttpClient("test-only", async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> };
    toolLists.push(body.tools.map(tool => tool.function.name));
    return new Response(JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "ready" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  });
  await client.complete(model, [], new AbortController().signal, 32, false);
  await client.complete(model, [], new AbortController().signal, 32, true);
  assert.deepEqual(toolLists[0], ["read_file", "list_files", "apply_patch"]);
  assert.deepEqual(toolLists[1], ["read_file", "list_files", "apply_patch", "run_check"], "configured local checks retain the existing tool set");
});

test("empty worker-local map uses the reduced request reservation and rejects a forged run_check before sandbox RPC", async () => {
  const expectedTools = [
    { type: "function", function: { name: "read_file", description: "Read a bounded UTF-8 file in the owned workspace", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
    { type: "function", function: { name: "list_files", description: "List bounded files in a workspace directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
    { type: "function", function: { name: "apply_patch", description: "Replace one exact text fragment in an owned regular file", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false } } }
  ];
  const messages = [
    { role: "system", content: `You are a bounded code builder. Work only in the exact checkout and slice scopes. Use only read_file, list_files, apply_patch. Worker-local checks never replace mandatory independent final verification. No shell, network, credentials, provider policy, verification, integration, or deployment authority. Candidate base is ${lease.mission.baseSha}. Owned scopes: ${lease.slice.scopes.join(", ")}.` },
    { role: "user", content: `Mission: ${lease.mission.objective}\nSlice: ${lease.slice.objective}\nAcceptance: ${lease.mission.acceptance.join("\n")}\nCheck IDs: ${lease.slice.checks.join(", ")}` }
  ];
  const requiredReservation = Buffer.byteLength(JSON.stringify({ model, messages, stream: false, thinking: { type: "disabled" }, tools: expectedTools, tool_choice: "auto", max_tokens: 1 }), "utf8") + 512;
  let completionCalls = 0, runCheckCalls = 0, closeCalls = 0;
  const results: WorkerResult[] = [];
  const provider = {
    async listModels() { return [model]; },
    async probeTools(id: string) { return { model: id, inputTokens: 1, outputTokens: 1 }; },
    async complete(id: string, _messages: unknown[], _signal: AbortSignal, _maxTokens: number, includeRunCheck?: boolean) {
      completionCalls++;
      assert.equal(includeRunCheck, false);
      return { model: id, inputTokens: 1, outputTokens: 1, message: { role: "assistant" as const, content: null, tool_calls: [{ id: "forged-check", type: "function" as const, function: { name: "run_check", arguments: JSON.stringify({ checkId: trustedChecks[0] }) } }] } };
    }
  };
  const workspace: WorkerWorkspace = {
    async checkout() {}, async readFile() { return ""; }, async listFiles() { return []; }, async replaceText() {},
    async runCheck() { runCheckCalls++; throw new Error("unconfigured local check must never reach sandbox RPC"); },
    async commitCandidate() { throw new Error("forged check must not produce a candidate"); }, async close() { closeCalls++; }
  };
  const blobs = new Map<string, Uint8Array>();
  const evidence = {
    async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; blobs.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; },
    async get(key: string) { const bytes = blobs.get(key); assert(bytes); return bytes; }
  };
  const referenceDigest = "0".repeat(64);
  const options: WorkerOptions = { allowedModels: [model], allowedProviders: ["deepseek"], trustedChecks, trustedCheckPolicyDigest: policyDigest, trustedCheckCommands: {}, sandboxImageRef: imageRef, maxToolCalls: 4, pricing };
  await executeLease({ ...lease, executionLimits: { ...lease.executionLimits, maxInputTokens: requiredReservation + 1 } }, {
    control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } },
    provider, runtime: { async create() { return workspace; } }, evidence,
    progress: { async append() { return { decision: "CONTINUE", reference: `sha256/${referenceDigest}:${referenceDigest}`, digest: referenceDigest }; } },
    checks: {}, options
  });
  assert.equal(completionCalls, 1, "the reduced three-tool reservation fits; reserving an unavailable run_check would block before completion");
  assert.equal(runCheckCalls, 0, "forged run_check is refused before Docker RPC");
  assert.equal(closeCalls, 1);
  assert.equal(results.length, 1);
  const result = results[0];
  assert(result);
  assert.equal("outcome" in result ? result.outcome : "candidate", "BLOCKED");
});

test("Docker runtime initializes only configured worker-local checks, including none", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orloom-optional-checks-runtime-"));
  try {
    const fixture = path.join(root, "fixture-repo"), scratch = path.join(root, "scratch"), trace = path.join(root, "docker-trace.jsonl"), state = path.join(root, "container.json"), fakeDocker = path.join(root, "fake-docker");
    await mkdir(fixture); await mkdir(scratch, { mode: 0o700 });
    execFileSync("git", ["init", "--quiet", fixture]);
    await writeFile(path.join(fixture, "README.md"), "local checkout fixture\n");
    execFileSync("git", ["-C", fixture, "add", "README.md"]);
    execFileSync("git", ["-C", fixture, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const baseSha = execFileSync("git", ["-C", fixture, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const containerId = "c".repeat(64);
    await writeFile(fakeDocker, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const args=process.argv.slice(2).slice(4), op=args[0], state=${JSON.stringify(state)}, trace=${JSON.stringify(trace)}, id=${JSON.stringify(containerId)};
fs.appendFileSync(trace,JSON.stringify({type:'cli',args})+'\\n');
if(op==='create') {
 const labels=Object.fromEntries(args.filter(x=>x.startsWith('--label=')).map(x=>{const v=x.slice(8),i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
 const name=args.find(x=>x.startsWith('--name=')).slice(7), image=args.at(-2);
 fs.writeFileSync(state,JSON.stringify({Id:id,Name:'/'+name,Config:{Image:image,Labels:labels},State:{Running:true}})); console.log(id);
} else if(op==='inspect') {
 if(!fs.existsSync(state)){console.error('Error: No such object: '+args.at(-1));process.exit(1);}
 console.log(fs.readFileSync(state,'utf8'));
} else if(op==='rm') fs.rmSync(state,{force:true});
else if(op==='start') {
 for await (const line of readline.createInterface({input:process.stdin})) {
  const req=JSON.parse(line); fs.appendFileSync(trace,JSON.stringify({type:'rpc',request:req})+'\\n');
  let value={initialized:true}; if(req.op==='init') value={initialized:true,fileCount:req.files.length,checks:req.checks};
  process.stdout.write(JSON.stringify({id:req.id,ok:true,value})+'\\n');
 }
}
`, { mode: 0o700 });
    await chmod(fakeDocker, 0o700);
    const configured = { "node-repo-suite-v1": { executable: "node", args: ["scripts/validate.mjs"], timeoutSeconds: 300 } };
    for (const checks of [{}, configured]) {
      const runtime = new DockerWorkerRuntime({ imageRef, installationId: 1, checkoutTokens: { async createCheckoutToken() { throw new Error("test must not request credentials"); } }, checkoutTransport: { async fetchExact(input) { await input.fetch(fixture); } }, checks, scratchRoot: scratch, dockerPath: fakeDocker });
      const workspace = await runtime.create({ ...lease, mission: { ...lease.mission, repository: "fixture/repo", baseSha } });
      await workspace.checkout("fixture/repo", baseSha);
      await workspace.close();
    }
    const requests = (await readFile(trace, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; request?: { op: string; checks: Record<string, unknown> } });
    const initChecks = requests.filter(row => row.type === "rpc" && row.request?.op === "init").map(row => row.request!.checks);
    assert.deepEqual(initChecks, [{}, configured]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
