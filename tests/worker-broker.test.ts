import { test } from "node:test";import { PassThrough, Writable } from "node:stream";import { EventEmitter } from "node:events";import type { ChildProcessWithoutNullStreams } from "node:child_process";import { cleanupOwnedContainer, dockerRemoveArgs, waitForWritableDrain, type DockerContainerControl } from "../apps/worker/src/docker-runtime.js";import assert from "node:assert/strict";import { createHash } from "node:crypto";import { createControlPlane } from "../apps/control-plane/src/server.js";import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js"; import { assertWorkerScopePath, DeepSeekHttpClient, executeLease, HttpControlPlane, ProviderOutcomeUnknown, R2WorkerProgressSink, type WorkerOptions } from "../packages/agents/src/worker.js";const model = "deepseek-chat";const policy = ["check:unit"];const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");const prices = { model, version: "test-snapshot-1", source: "operator fixture", capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), inputCentsPerMillion: 100, outputCentsPerMillion: 100, reasoningCentsPerMillion: 100, safetyMultiplier: 1.25 };const sandboxImageRef = `sha256:${"d".repeat(64)}`;const trustedCheckCommands = { "check:unit": { executable: "node", args: ["scripts/test.mjs"], timeoutSeconds: 30 } };const options: WorkerOptions = { allowedModels: [model], allowedProviders: ["deepseek"], trustedChecks: policy, trustedCheckPolicyDigest: policyDigest, trustedCheckCommands, sandboxImageRef, maxToolCalls: 8, pricing: prices };function leaseWithInputLimit(maxInputTokens: number): WorkerLeaseContract {  return { protocol: "orloom.worker-lease.v1", mission: { id: "mission-test", repository: "owner/repo", baseSha: "a".repeat(40), objective: "bounded test", acceptance: ["test" ] }, slice: { id: "slice-test", objective: "one scoped change", dependencies: [], owner: "builder", scopes: ["src/**"], checks: policy }, capacitySlot: 1, leaseEpoch: 1, leaseToken: "lease-token", capabilityToken: "capability-token", leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), trustedCheckPolicyDigest: policyDigest, planDigest: "b".repeat(64), executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens, maxOutputTokens: 100, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: [model] } };}test("worker transport claims through real HTTP, patches an owned path, stores evidence, and only submits awaiting_verification", async () => {  const owner = "owner-test-token", bootstrap = "worker-bootstrap-test", store = new MemoryMissionStore();  await store.configureCapacity(1, "b".repeat(64), new Date(Date.now() + 120_000).toISOString());  const server = createControlPlane({ mode: "local", port: 0, sessionToken: owner, workerToken: bootstrap, capacitySlots: 1, maxLanes: 6, trustedCheckPolicy: policy, trustedCheckPolicyDigest: policyDigest, workerMaxProviderCalls: 4, workerMaxInputTokens: 10_000, workerMaxOutputTokens: 100, workerMaxWallSeconds: 60, workerAllowedProviders: ["deepseek"], workerAllowedModels: [model] }, new MemoryJobStore(), store);  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));  const address = server.address(); assert(address && typeof address !== "string");  const base = `http://127.0.0.1:${address.port}`;  try {    const login = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: owner }) });    const cookie = login.headers.get("set-cookie")?.split(";")[0]; assert(cookie);    const missionResponse = await fetch(`${base}/api/missions`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ repository: "owner/repo", baseSha: "a".repeat(40), objective: "bounded change", acceptance: ["unit check"], budgetCents: 100 }) });    assert.equal(missionResponse.status, 201);    const mission = await missionResponse.json() as { id: string };    const plan = await fetch(`${base}/api/missions/${mission.id}/plan`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ slices: [{ id: "slice-1", objective: "edit one file", dependencies: [], owner: "builder", scopes: ["src/**"], checks: ["check:unit"], budgetCents: 100 }] }) });    assert.equal(plan.status, 201);    assert.equal((await fetch(`${base}/api/missions/${mission.id}/approve`, { method: "POST", headers: { cookie } })).status, 200);    const control = new HttpControlPlane(base, bootstrap);    const lease = await control.claim(); assert(lease);    let patchText = "old", providerStep = 0;    const evidence = new Map<string, Uint8Array>();    const provider = {      async listModels() { return [model]; },      async probeTools(id: string) { return { model: id, inputTokens: 2, outputTokens: 1 }; },      async complete(id: string, _messages: unknown[], _signal: AbortSignal, maxTokens: number) {        assert(maxTokens > 0);        if (providerStep++ === 0) return { model: id, inputTokens: 4, outputTokens: 2, message: { role: "assistant" as const, content: null, tool_calls: [{ id: "check1", type: "function" as const, function: { name: "run_check", arguments: JSON.stringify({ checkId: "check:unit" }) } }] } };        if (patchText === "old") return { model: id, inputTokens: 4, outputTokens: 2, message: { role: "assistant" as const, content: null, tool_calls: [{ id: "patch1", type: "function" as const, function: { name: "apply_patch", arguments: JSON.stringify({ path: "src/file.ts", oldText: "old", newText: "new" }) } }] } };        return { model: id, inputTokens: 4, outputTokens: 2, message: { role: "assistant" as const, content: "complete", } };      }    };    const runtime = { async create() { return {      async checkout(repository: string, baseSha: string) { assert.equal(repository, "owner/repo"); assert.equal(baseSha, "a".repeat(40)); },      async readFile(path: string) { assert.equal(path, "src/file.ts"); return patchText; },      async listFiles() { return ["src/file.ts"]; },      async replaceText(_path: string, oldText: string, newText: string) { assert.equal(patchText, oldText); patchText = newText; },      async runCheck(id: string) { assert.equal(id, "check:unit"); const output = "check failed with a deterministic fixture"; return { exitCode: 1, output, outputSha256: createHash("sha256").update(output).digest("hex"), commandDigest: createHash("sha256").update(JSON.stringify(trustedCheckCommands[id])).digest("hex"), durationMs: 4, imageRef: sandboxImageRef }; },      async commitCandidate() { return { candidateSha: "c".repeat(40), diff: new TextEncoder().encode("diff --git a/src/file.ts b/src/file.ts\n-old\n+new\n"), bundle: new TextEncoder().encode("test-only Git bundle fixture") }; },      async close() {}    }; } };    const evidenceStore = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; evidence.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { const bytes = evidence.get(key); assert(bytes); return bytes; } };    await executeLease(lease, { control, provider, runtime, evidence: evidenceStore, progress: new R2WorkerProgressSink(evidenceStore), checks: { "check:unit": ["unit-check"] }, options });    assert.equal(patchText, "new");    const record = await (await fetch(`${base}/api/missions/${mission.id}`, { headers: { cookie } })).json() as { slices: Array<{ status: string; candidateSha: string; evidenceRefs: string[] }> };    assert.equal(record.slices[0]?.status, "awaiting_verification");    assert.equal(record.slices[0]?.candidateSha, "c".repeat(40));    assert(record.slices[0]!.evidenceRefs.length >= 3);    assert(record.slices[0]!.evidenceRefs.some(ref => ref.startsWith("candidate-bundle:sha256/")), "candidate commit bundle must be retained for independent integration");    const indexRef = record.slices[0]!.evidenceRefs.find(ref => ref.startsWith("evidence-index:sha256/")); assert(indexRef);    const indexKey = indexRef.slice(indexRef.indexOf(":") + 1); const index = JSON.parse(Buffer.from(evidence.get(indexKey)!).toString("utf8")) as { entries: Array<{ name: string; reference: string; key?: string }> };    const checkEntry = index.entries.find(entry => entry.name === "check-check:unit"); assert(checkEntry); const checkKey = checkEntry.key!;    const checkEvidence = JSON.parse(Buffer.from(evidence.get(checkKey)!).toString("utf8")) as { exitCode: number; baseSha: string; candidateSha: null; commandDigest: string; imageRef: string };    assert.equal(checkEvidence.exitCode, 1, "failed check output is evidence, not a worker certification gate");    assert.equal(checkEvidence.baseSha, "a".repeat(40));    assert.equal(checkEvidence.candidateSha, null);    assert.equal(checkEvidence.imageRef, sandboxImageRef);    assert.equal(checkEvidence.commandDigest, createHash("sha256").update(JSON.stringify(trustedCheckCommands["check:unit"])).digest("hex"));    const events = await (await fetch(`${base}/api/missions/${mission.id}/events?after=0`, { headers: { cookie } })).json() as Array<{ type: string }>;    assert(events.some(e => e.type === "slice.awaiting_verification"));    assert.equal((await fetch(`${base}/api/worker/claim`, { method: "POST", headers: { authorization: `Bearer ${bootstrap}` } })).status, 204, "the worker cannot promote or self-certify the result");  } finally {    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));  }});test("DeepSeek HTTP adapter probes exact function-call support and suppresses reasoning fields", async () => {  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];  const fakeFetch: typeof fetch = async (input, init) => {    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};    calls.push({ url, body });    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });    const probe = body.tool_choice !== "auto";    return new Response(JSON.stringify({ model, choices: [{ message: { role: "assistant", content: probe ? null : "safe", reasoning_content: "must not escape", ...(probe ? { tool_calls: [{ id: "probe", type: "function", function: { name: "orloom_tool_probe", arguments: "{\"ok\":true}" } }] } : {}) } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });  };  const client = new DeepSeekHttpClient("fake-test-secret", fakeFetch, "https://api.deepseek.com");  assert.deepEqual(await client.listModels(), [model]);  assert.deepEqual(await client.probeTools(model, new AbortController().signal), { model, inputTokens: 3, outputTokens: 1 });  const response = await client.complete(model, [], new AbortController().signal, 12);  assert.equal(response.message.content, "safe");  assert.equal("reasoning_content" in response.message, false);  const completion = calls.at(-1)!;  assert.equal(completion.url, "https://api.deepseek.com/chat/completions");  assert.deepEqual(completion.body.thinking, { type: "disabled" });  assert.equal(completion.body.max_tokens, 12);});test("input reservation blocks before the first billable capability probe", async () => {  const results: unknown[] = [];  let probeCalls = 0, completionCalls = 0;  const provider = { async listModels() { return [model]; }, async probeTools() { probeCalls++; return { model, inputTokens: 1, outputTokens: 1 }; }, async complete() { completionCalls++; throw new Error("must not be reached"); } };  const workspace = { async checkout() {}, async readFile() { return ""; }, async listFiles() { return []; }, async replaceText() {}, async runCheck() { throw new Error("not expected"); }, async commitCandidate() { throw new Error("not expected"); }, async close() {} };  const stored = new Map<string, Uint8Array>();  const evidence = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; stored.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { return stored.get(key)!; } };  await executeLease(leaseWithInputLimit(1), { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence, progress: { async append() { return { decision: "CONTINUE", reference: "sha256/0000000000000000000000000000000000000000000000000000000000000000", digest: "0000000000000000000000000000000000000000000000000000000000000000" }; } }, checks: { "check:unit": ["unit-check"] }, options });  assert.equal(probeCalls, 0);  assert.equal(completionCalls, 0);  assert.deepEqual(results.map(x => (x as { outcome: string }).outcome), ["BLOCKED"]);});test("durable STOP before probe prevents billable provider effect", async () => {  const results: unknown[] = [];  let probeCalls = 0;  const provider = { async listModels() { return [model]; }, async probeTools() { probeCalls++; return { model, inputTokens: 1, outputTokens: 1 }; }, async complete() { throw new Error("not expected"); } };  const workspace = { async checkout() {}, async readFile() { return ""; }, async listFiles() { return []; }, async replaceText() {}, async runCheck() { throw new Error("not expected"); }, async commitCandidate() { throw new Error("not expected"); }, async close() {} };  const stored = new Map<string, Uint8Array>();  const evidence = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; stored.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { return stored.get(key)!; } };  await executeLease(leaseWithInputLimit(10_000), { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence, progress: { async append() { return { decision: "STOP", reference: "sha256/0000000000000000000000000000000000000000000000000000000000000000", digest: "0000000000000000000000000000000000000000000000000000000000000000" }; } }, checks: { "check:unit": ["unit-check"] }, options });  assert.equal(probeCalls, 0);  assert.deepEqual(results.map(x => (x as { outcome: string }).outcome), ["BLOCKED"]);});test("DeepSeek ambiguous POST is not retried, response redirects are disabled, and hostile paths fail closed", async () => {  let posts = 0, redirect: RequestRedirect | undefined;  const client = new DeepSeekHttpClient("test-only", async (_input, init) => { posts++; redirect = init?.redirect; throw new Error("network interrupted after send"); });  await assert.rejects(client.complete(model, [], new AbortController().signal, 20), ProviderOutcomeUnknown);  assert.equal(posts, 1);  assert.equal(redirect, "error");  assert.equal(assertWorkerScopePath("src/file.ts", ["src/**"]), "src/file.ts");  for (const value of ["../secret", "src/../secret", "src/.git/config", "src\\secret", "src/file\nname"]) assert.throws(() => assertWorkerScopePath(value, ["src/**"]));  assert.throws(() => new HttpControlPlane("https://user:password@control.example", "bootstrap"));});
test("high progress volume retains a complete immutable index with bounded terminal references", async () => {
  const lease = leaseWithInputLimit(1_000_000);
  lease.executionLimits.maxProviderCalls = 50;
  lease.executionLimits.maxOutputTokens = 1_000;
  lease.executionLimits.reservedBudgetCents = 1_000;
  const manyOptions = { ...options, maxToolCalls: 50 };
  const evidence = new Map<string, Uint8Array>();
  const store = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; evidence.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { return evidence.get(key)!; } };
  let calls = 0;
  const provider = {
    async listModels() { return [model]; },
    async probeTools(id: string) { return { model: id, inputTokens: 1, outputTokens: 1 }; },
    async complete(id: string) {
      const index = calls++;
      if (index < 42) return { model: id, inputTokens: 1, outputTokens: 1, message: { role: "assistant" as const, content: null, tool_calls: [{ id: `list-${index}`, type: "function" as const, function: { name: "list_files", arguments: JSON.stringify({ path: "src/file.ts" }) } }] } };
      return { model: id, inputTokens: 1, outputTokens: 1, message: { role: "assistant" as const, content: "candidate ready" } };
    }
  };
  const workspace = { async checkout() {}, async readFile() { return ""; }, async listFiles() { return ["src/file.ts"]; }, async replaceText() {}, async runCheck() { throw new Error("not expected"); }, async commitCandidate() { return { candidateSha: "c".repeat(40), diff: new TextEncoder().encode("diff"), bundle: new TextEncoder().encode("bundle") }; }, async close() {} };
  const results: Array<{ candidateSha?: string; evidenceRefs: string[]; outcome?: string; reasonCode?: string }> = [];
  await executeLease(lease, { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence: store, progress: new R2WorkerProgressSink(store), checks: { "check:unit": ["unit-check"] }, options: manyOptions });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.candidateSha, "c".repeat(40), JSON.stringify(results[0]));
  assert(results[0]!.evidenceRefs.length < 100);
  const indexRef = results[0]!.evidenceRefs.find(ref => ref.startsWith("evidence-index:sha256/")); assert(indexRef);
  const indexKey = indexRef.slice(indexRef.indexOf(":") + 1);
  const index = JSON.parse(Buffer.from(evidence.get(indexKey)!).toString("utf8")) as { entries: Array<{ name: string; sha256: string }> };
  const progressEntries = index.entries.filter(entry => entry.name === "progress");
  assert(progressEntries.length > 100, "progress records remain indexed even though terminal refs are bounded");
  assert(progressEntries.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test("sandbox drain wait rejects on early close and abort without leaked listeners", async () => {
  const stream = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  assert.equal(stream.write("buffered"), false);
  const controller = new AbortController();
  const waiting = waitForWritableDrain(stream, controller.signal);
  stream.destroy();
  await assert.rejects(waiting, /closed before drain/);
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("close"), 0);
  const second = new PassThrough({ highWaterMark: 1 });
  assert.equal(second.write("buffered"), false);
  const aborting = waitForWritableDrain(second, controller.signal);
  controller.abort();
  await assert.rejects(aborting, /interrupted/);
  assert.equal(second.listenerCount("drain"), 0);
  assert.equal(second.listenerCount("close"), 0);
  second.destroy();
  const third = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  assert.equal(third.write("buffered"), false);
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const exiting = waitForWritableDrain(third, new AbortController().signal, child);
  child.emit("exit", 1, null);
  await assert.rejects(exiting, /process exited before input drain/);
  assert.equal(child.listenerCount("exit"), 0);
  third.destroy();
});

test("Docker rm argv uses only supported remove flags", () => { const id = "a".repeat(64); assert.deepEqual(dockerRemoveArgs(id), ["rm", "--force", id]); });
test("sandbox cleanup verifies exact owner, removes by ID, and checks absence", async () => {
  const id = "a".repeat(64);
  const labels = { "com.orloom.worker-owned": "true", "com.orloom.lease-epoch": "4", "com.orloom.instance": "lease-a" };
  const expected = { name: 'lease-a', imageRef: sandboxImageRef };
  const identity = { name: '/lease-a', imageRef: sandboxImageRef };
  let current: { id: string; labels: Record<string, string>; name: string; imageRef: string } | null = { id, labels, ...identity };
  let removed = "";
  const control: DockerContainerControl = { async inspect(asked) { assert.equal(asked, id); return current; }, async remove(asked) { removed = asked; current = null; } };
  await cleanupOwnedContainer(control, id, labels, expected);
  assert.equal(removed, id);
  let absentRemove = false;
  await cleanupOwnedContainer({ async inspect() { return null; }, async remove() { absentRemove = true; } }, id, labels, expected);
  assert.equal(absentRemove, false, "already-crashed container is verified absent without a blind removal");
  let foreignRemoved = false;
  await assert.rejects(cleanupOwnedContainer({ async inspect() { return { id, ...identity, labels: { ...labels, "com.orloom.worker-owned": "false" } }; }, async remove() { foreignRemoved = true; } }, id, labels, expected), /ownership labels/);
  assert.equal(foreignRemoved, false);
  await assert.rejects(cleanupOwnedContainer({ async inspect() { throw new Error("Docker daemon unavailable"); }, async remove() {} }, id, labels, expected), /unavailable/);
  await assert.rejects(cleanupOwnedContainer({ async inspect() { return { id, labels, ...identity }; }, async remove() {} }, id, labels, expected), /remains present/);
  let removedThenLostConnection = false;
  await assert.rejects(cleanupOwnedContainer({ async inspect() { if (removedThenLostConnection) throw new Error("inspection connection lost"); return { id, labels, ...identity }; }, async remove() { removedThenLostConnection = true; } }, id, labels, expected), /inspection connection lost/);
  let removeReturnedError = false;
  await cleanupOwnedContainer({ async inspect() { return removeReturnedError ? null : { id, labels, ...identity }; }, async remove() { removeReturnedError = true; throw new Error("already gone"); } }, id, labels, expected);
});

test("pricing expiry between calls blocks the next billable request and preserves snapshot evidence", async () => {
  let currentTime = Date.now();
  const expiry = currentTime + 20;
  const expiringOptions: WorkerOptions = { ...options, pricing: { ...prices, capturedAt: new Date(currentTime - 1).toISOString(), expiresAt: new Date(expiry).toISOString() } };
  const lease = leaseWithInputLimit(10_000);
  const evidence = new Map<string, Uint8Array>();
  const store = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; evidence.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { return evidence.get(key)!; } };
  let probeCalls = 0, completionCalls = 0;
  const provider = {
    async listModels() { return [model]; },
    async probeTools(id: string) { probeCalls++; currentTime = expiry; return { model: id, inputTokens: 1, outputTokens: 1 }; },
    async complete() { completionCalls++; throw new Error("stale pricing must prevent this call"); }
  };
  const workspace = { async checkout() {}, async readFile() { return ""; }, async listFiles() { return []; }, async replaceText() {}, async runCheck() { throw new Error("not expected"); }, async commitCandidate() { throw new Error("not expected"); }, async close() {} };
  const results: Array<{ outcome?: string; evidenceRefs: string[] }> = [];
  const digest = "0".repeat(64);
  await executeLease(lease, { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence: store, progress: { async append() { return { decision: "CONTINUE", reference: `sha256/${digest}:${digest}`, digest }; } }, checks: { "check:unit": ["unit-check"] }, options: expiringOptions, now: () => currentTime });
  assert.equal(probeCalls, 1);
  assert.equal(completionCalls, 0);
  assert.equal(results[0]?.outcome, "BLOCKED");
  const indexRef = results[0]!.evidenceRefs.find(ref => ref.startsWith("evidence-index:sha256/")); assert(indexRef);
  const indexKey = indexRef.slice(indexRef.indexOf(":") + 1);
  const index = JSON.parse(Buffer.from(evidence.get(indexKey)!).toString("utf8")) as { entries: Array<{ name: string; key: string }> };
  const snapshot = index.entries.find(entry => entry.name === "pricing-snapshot"); assert(snapshot);
  assert.equal(JSON.parse(Buffer.from(evidence.get(snapshot.key)!).toString("utf8")).expiresAt, new Date(expiry).toISOString());
});

test("an interrupted sandbox RPC produces one UNKNOWN callback and is never retried", async () => {
  const results: Array<{ outcome?: string; candidateSha?: string }> = [];
  let completionCalls = 0, closeCalls = 0;
  const provider = {
    async listModels() { return [model]; },
    async probeTools(id: string) { return { model: id, inputTokens: 1, outputTokens: 1 }; },
    async complete(id: string) { completionCalls++; return { model: id, inputTokens: 1, outputTokens: 1, message: { role: "assistant" as const, content: null, tool_calls: [{ id: "read1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "src/file.ts" }) } }] } }; }
  };
  const workspace = { async checkout() {}, async readFile() { throw new Error("Sandbox RPC interrupted; operation outcome may be unknown"); }, async listFiles() { return []; }, async replaceText() {}, async runCheck() { throw new Error("not expected"); }, async commitCandidate() { throw new Error("not expected"); }, async close() { closeCalls++; } };
  const stored = new Map<string, Uint8Array>();
  const evidence = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; stored.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { return stored.get(key)!; } };
  await executeLease(leaseWithInputLimit(10_000), { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence, progress: { async append() { const hash = "0".repeat(64); return { decision: "CONTINUE", reference: `sha256/${hash}:${hash}`, digest: hash }; } }, checks: { "check:unit": ["unit-check"] }, options });
  assert.equal(completionCalls, 1);
  assert.equal(closeCalls, 1);
  assert.deepEqual(results.map(result => result.outcome), ["UNKNOWN"]);
});

test("uncertain sandbox cleanup prevents candidate submission and reports UNKNOWN once", async () => {
  const results: Array<{ outcome?: string; candidateSha?: string }> = [];
  const provider = { async listModels() { return [model]; }, async probeTools(id: string) { return { model: id, inputTokens: 1, outputTokens: 1 }; }, async complete(id: string) { return { model: id, inputTokens: 1, outputTokens: 1, message: { role: "assistant" as const, content: "candidate ready" } }; } };
  const workspace = { async checkout() {}, async readFile() { return ""; }, async listFiles() { return []; }, async replaceText() {}, async runCheck() { throw new Error("not expected"); }, async commitCandidate() { return { candidateSha: "c".repeat(40), diff: new TextEncoder().encode("diff"), bundle: new TextEncoder().encode("bundle") }; }, async close() { throw new Error("container absence could not be verified"); } };
  const stored = new Map<string, Uint8Array>();
  const evidence = { async put(bytes: Uint8Array) { const hash = createHash("sha256").update(bytes).digest("hex"); const key = `sha256/${hash}`; stored.set(key, new Uint8Array(bytes)); return { key, sha256: hash }; }, async get(key: string) { return stored.get(key)!; } };
  await executeLease(leaseWithInputLimit(10_000), { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence, progress: { async append() { const hash = "0".repeat(64); return { decision: "CONTINUE", reference: `sha256/${hash}:${hash}`, digest: hash }; } }, checks: { "check:unit": ["unit-check"] }, options });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.outcome, "UNKNOWN");
  assert.equal(results[0]?.candidateSha, undefined);
});

test("owner cancellation during provider execution fences a late reply and closes workspace exactly once", async () => {
  const lease = leaseWithInputLimit(10_000);
  let cancelled = false, closed = 0, patches = 0, commits = 0, completions = 0;
  const results: unknown[] = [];
  const evidence = new Map<string, Uint8Array>();
  const store = { async put(bytes: Uint8Array) { const hash = createHash('sha256').update(bytes).digest('hex'); const key = `sha256/${hash}`; evidence.set(key, bytes); return { key, sha256: hash }; }, async get(key: string) { return evidence.get(key)!; } };
  const provider = {
    async listModels() { return [model]; },
    async probeTools(id: string) { return { model: id, inputTokens: 1, outputTokens: 1 }; },
    async complete(id: string, _messages: unknown[], signal: AbortSignal) {
      completions++; cancelled = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cancellation never reached running provider')), 5000);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      // A noncooperating transport returns a late tool call after abort.
      return { model: id, inputTokens: 1, outputTokens: 1, message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'late', type: 'function' as const, function: { name: 'apply_patch', arguments: JSON.stringify({ path: 'src/file.ts', oldText: 'old', newText: 'new' }) } }] } };
    }
  };
  const workspace = { async checkout() {}, async readFile() { return 'old'; }, async listFiles() { return []; }, async replaceText() { patches++; }, async runCheck() { throw new Error('unexpected'); }, async commitCandidate() { commits++; throw new Error('unexpected'); }, async close() { closed++; } };
  await executeLease(lease, { control: { async claim() { return null; }, async heartbeat() {}, async cancellationRequested() { return cancelled; }, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { return workspace; } }, evidence: store, progress: new R2WorkerProgressSink(store), checks: { 'check:unit': ['unit-check'] }, options });
  assert.equal(completions, 1);
  assert.equal(patches, 0);
  assert.equal(commits, 0);
  assert.equal(closed, 1);
  assert.deepEqual(results.map(x => (x as { outcome: string }).outcome), ['UNKNOWN']);
});

test("service AbortSignal reaches executeLease preflight and records UNKNOWN without claiming owner cancellation", async () => {
  const controller = new AbortController();
  const results: unknown[] = [];
  let entered = false, created = 0;
  const provider = {
    async listModels(signal?: AbortSignal) {
      entered = true;
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    },
    async probeTools() { throw new Error("provider probe must not run"); },
    async complete() { throw new Error("completion must not run"); },
  };
  const promise = executeLease(leaseWithInputLimit(10_000), { control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { results.push(result); } }, provider, runtime: { async create() { created++; throw new Error("runtime must not start"); } }, evidence: { async put() { throw new Error("evidence must not be written"); }, async get() { throw new Error("evidence must not be read"); } }, progress: { async append() { throw new Error("progress must not be emitted"); } }, checks: { "check:unit": ["unit-check"] }, options, signal: controller.signal });
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(new Error("SIGTERM"));
  await promise;
  assert.equal(created, 0);
  assert.deepEqual(results.map(x => (x as { outcome: string }).outcome), ["UNKNOWN"]);
});
