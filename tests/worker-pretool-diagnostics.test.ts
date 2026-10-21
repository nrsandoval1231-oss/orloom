import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DeepSeekMessage, DeepSeekToolCall, WorkerOptions } from "../packages/agents/src/worker.js";
import { executeLease, WorkerProtocolError } from "../packages/agents/src/worker.js";
import type { WorkerLeaseContract } from "../packages/contracts/src/worker-protocol.js";

const model = "deepseek-chat";
const checks: string[] = [];
const policyDigest = createHash("sha256").update(JSON.stringify(checks)).digest("hex");
const imageRef = `sha256:${"d".repeat(64)}`;
const options: WorkerOptions = {
  allowedModels: [model], allowedProviders: ["deepseek"], trustedChecks: checks,
  trustedCheckPolicyDigest: policyDigest, trustedCheckCommands: {}, sandboxImageRef: imageRef,
  maxToolCalls: 8,
  pricing: { model, version: "diagnostic-fixture", source: "local fixture", capturedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), inputCentsPerMillion: 100, outputCentsPerMillion: 100, reasoningCentsPerMillion: 100, safetyMultiplier: 1.2 }
};

function lease(): WorkerLeaseContract {
  return {
    protocol: "orloom.worker-lease.v1",
    mission: { id: "diagnostic-mission", repository: "owner/repo", baseSha: "a".repeat(40), objective: "diagnostic fixture", acceptance: ["deterministic test"] },
    slice: { id: "diagnostic-slice", objective: "one scoped change", dependencies: [], owner: "builder", scopes: ["src/**"], checks },
    capacitySlot: 1, leaseEpoch: 1, leaseToken: "lease-fixture", capabilityToken: "capability-fixture",
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), trustedCheckPolicyDigest: policyDigest,
    planDigest: "b".repeat(64),
    executionLimits: { reservedBudgetCents: 100, maxProviderCalls: 4, maxInputTokens: 100_000, maxOutputTokens: 5_000, maxWallSeconds: 60, allowedProviders: ["deepseek"], allowedModels: [model] }
  };
}

function createCall(id: string, args: string, name = "create_file"): DeepSeekToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

async function runScenario(completions: Array<{ model?: string; message: DeepSeekMessage }>, optionsOverride: Partial<WorkerOptions> = {}) {
  const artifacts = new Map<string, Uint8Array>();
  const resultRows: unknown[] = [];
  const progress: Array<{ phase: string; status: string }> = [];
  const created: Array<{ path: string; text: string }> = [];
  let completionIndex = 0;
  const workspace = {
    async checkout() {},
    async readFile() { throw new Error("unexpected read"); },
    async listFiles() { return []; },
    async createFile(path: string, text: string) { created.push({ path, text }); },
    async replaceText() { throw new Error("unexpected patch"); },
    async runCheck() { throw new Error("unexpected check"); },
    async commitCandidate() {
      if (!created.length) throw new WorkerProtocolError("Worker produced no candidate changes");
      return { candidateSha: "c".repeat(40), diff: new TextEncoder().encode("fixture diff"), bundle: new TextEncoder().encode("fixture bundle") };
    },
    async close() {}
  };
  const evidence = {
    async put(bytes: Uint8Array) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      const key = `sha256/${digest}`;
      artifacts.set(key, new Uint8Array(bytes));
      return { key, sha256: digest };
    },
    async get(key: string) { const value = artifacts.get(key); assert(value); return value; }
  };
  const provider = {
    async listModels() { return [model]; },
    async probeTools(id: string) { return { model: id, inputTokens: 1, outputTokens: 1 }; },
    async complete(id: string) {
      const next = completions[completionIndex++];
      assert(next, "fixture supplied enough completion responses");
      return { model: next.model ?? id, inputTokens: 2, outputTokens: 3, message: next.message };
    }
  };
  const digestProgress = { async append(_lease: WorkerLeaseContract, event: { phase: string; status: string }) {
    progress.push({ phase: event.phase, status: event.status });
    const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    return { decision: "CONTINUE" as const, reference: `sha256/${digest}:${digest}`, digest };
  } };
  await executeLease(lease(), {
    control: { async claim() { return null; }, async heartbeat() {}, async result(_lease, result) { resultRows.push(result); } },
    provider, runtime: { async create() { return workspace; } }, evidence, progress: digestProgress,
    checks: {}, options: { ...options, ...optionsOverride }
  });
  const rows = [...artifacts.entries()].map(([key, bytes]) => ({ key, text: Buffer.from(bytes).toString("utf8") }));
  const diagnostics = rows.filter(row => row.text.includes("orloom.worker-pretool-diagnostic.v1")).map(row => ({ key: row.key, value: JSON.parse(row.text) as Record<string, unknown>, text: row.text }));
  const evidenceIndex = rows.filter(row => row.text.includes('"version":"orloom.worker-evidence-index.v1"')).map(row => JSON.parse(row.text) as { entries: Array<{ name: string }> });
  return { results: resultRows, progress, created, diagnostics, evidenceIndex, rows };
}

function oneToolDiagnostic(result: Awaited<ReturnType<typeof runScenario>>) {
  assert.equal(result.diagnostics.length, 1);
  return result.diagnostics[0]!.value as { status: string; stage: string; code: string; replyModelMatchesConfigured: boolean; toolCount: number; toolCountTruncated: boolean; toolCountExceeded: boolean; calls: Array<{ toolNameCategory: string; argumentBytes: number | null; argumentBytesTruncated: boolean; stage: string; code: string }> };
}

test("pre-tool diagnostics record malformed arguments without copying their bytes or response content", async () => {
  const result = await runScenario([{ message: { role: "assistant", content: "RESPONSE_SECRET_SENTINEL", tool_calls: [createCall("ID_SECRET_SENTINEL", "{\"path\":\"src/PATH_SECRET_SENTINEL" )] } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.status, diagnostic.stage, diagnostic.code], ["rejected", "arguments", "malformed_arguments"]);
  assert.equal(diagnostic.replyModelMatchesConfigured, true);
  assert.deepEqual(diagnostic.calls.map(call => call.toolNameCategory), ["create_file"]);
  assert(diagnostic.calls[0]!.argumentBytes! > 0);
  assert.equal(result.created.length, 0);
  assert.deepEqual((result.results[0] as { outcome: string }).outcome, "BLOCKED");
  assert(result.evidenceIndex[0]!.entries.some(entry => entry.name === "pretool-diagnostic-1"));
  assert(!result.diagnostics[0]!.text.includes("SECRET_SENTINEL"));
});

test("unknown tool names are categorized without persisting names, IDs, arguments, or response text", async () => {
  const result = await runScenario([{ message: { role: "assistant", content: "RESPONSE_SECRET_SENTINEL", tool_calls: [createCall("ID_SECRET_SENTINEL", "{\"payload\":\"ARG_SECRET_SENTINEL\"}", "SECRET_TOOL_SENTINEL")] } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.stage, diagnostic.code], ["tool_validation", "unknown_tool"]);
  assert.deepEqual(diagnostic.calls.map(call => call.toolNameCategory), ["unknown"]);
  assert(!result.diagnostics[0]!.text.includes("SECRET_SENTINEL"));
  assert(!result.diagnostics[0]!.text.includes("ARG_SECRET_SENTINEL"));
});

test("out-of-scope paths produce an enum diagnostic without retaining the path", async () => {
  const result = await runScenario([{ message: { role: "assistant", content: "response", tool_calls: [createCall("id", JSON.stringify({ path: "outside/PATH_SECRET_SENTINEL.ts", text: "BODY_SECRET_SENTINEL" }))] } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.stage, diagnostic.code], ["tool_validation", "scope_rejected"]);
  assert(!result.diagnostics[0]!.text.includes("PATH_SECRET_SENTINEL"));
  assert(!result.diagnostics[0]!.text.includes("BODY_SECRET_SENTINEL"));
  assert.equal(result.created.length, 0);
});

test("duplicate tool IDs fail closed and the content-free diagnostic identifies only the failing position", async () => {
  const args = JSON.stringify({ path: "src/new.ts", text: "BODY_SECRET_SENTINEL" });
  const result = await runScenario([{ message: { role: "assistant", content: "response", tool_calls: [createCall("ID_SECRET_SENTINEL", args), createCall("ID_SECRET_SENTINEL", args)] } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.stage, diagnostic.code], ["identity", "duplicate_tool_id"]);
  assert.deepEqual(diagnostic.calls.map(call => call.code), ["validated", "duplicate_tool_id"]);
  assert(!result.diagnostics[0]!.text.includes("SECRET_SENTINEL"));
  assert.equal(result.created.length, 0);
  assert.deepEqual((result.results[0] as { outcome: string }).outcome, "UNKNOWN");
});

test("tool count diagnostics are saturated and preserve the local call cap", async () => {
  const calls = Array.from({ length: 9 }, (_, index) => createCall(`id-${index}`, JSON.stringify({ path: `src/${index}.ts`, text: "body" })));
  const result = await runScenario([{ message: { role: "assistant", content: null, tool_calls: calls } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.stage, diagnostic.code, diagnostic.toolCount, diagnostic.toolCountExceeded], ["tool_count", "tool_count_exceeded", 9, true]);
  assert.equal(diagnostic.calls.length, 9);
  assert.equal(result.created.length, 0);
  assert.deepEqual((result.results[0] as { outcome: string }).outcome, "UNKNOWN");
});

test("valid create_file and later empty-tool response are separately recorded and a candidate succeeds", async () => {
  const result = await runScenario([
    { message: { role: "assistant", content: null, tool_calls: [createCall("id-create", JSON.stringify({ path: "src/new.ts", text: "export const draft = true;\n" }))] } },
    { message: { role: "assistant", content: "RESPONSE_SECRET_SENTINEL" } }
  ]);
  assert.deepEqual(result.created, [{ path: "src/new.ts", text: "export const draft = true;\n" }]);
  assert.equal(result.diagnostics.length, 2);
  const [accepted, empty] = result.diagnostics.map(row => row.value as { status: string; stage: string; code: string; toolCount: number });
  assert.deepEqual([accepted!.status, accepted!.stage, accepted!.code, accepted!.toolCount], ["accepted", "tool_validation", "validated", 1]);
  assert.deepEqual([empty!.status, empty!.stage, empty!.code, empty!.toolCount], ["no_tool_calls", "proposal", "no_tool_calls", 0]);
  assert.deepEqual((result.results[0] as { candidateSha: string }).candidateSha, "c".repeat(40));
  assert(result.evidenceIndex[0]!.entries.some(entry => entry.name === "pretool-diagnostic-1"));
  assert(result.evidenceIndex[0]!.entries.some(entry => entry.name === "pretool-diagnostic-2"));
  assert(!result.diagnostics.some(row => row.text.includes("RESPONSE_SECRET_SENTINEL")));
});

test("empty-tool response diagnostic is bound into failure evidence before empty-candidate rejection", async () => {
  const result = await runScenario([{ message: { role: "assistant", content: "RESPONSE_SECRET_SENTINEL" } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.status, diagnostic.stage, diagnostic.code, diagnostic.toolCount], ["no_tool_calls", "proposal", "no_tool_calls", 0]);
  assert.deepEqual((result.results[0] as { outcome: string; evidenceRefs: string[] }).outcome, "BLOCKED");
  assert(result.evidenceIndex[0]!.entries.some(entry => entry.name === "pretool-diagnostic-1"));
  assert(!result.diagnostics[0]!.text.includes("RESPONSE_SECRET_SENTINEL"));
});

test("diagnostic records only model-match boolean when the completion model is mismatched", async () => {
  const result = await runScenario([{ model: "MODEL_SECRET_SENTINEL", message: { role: "assistant", content: "response", tool_calls: [createCall("id", "{}") ] } }]);
  const diagnostic = oneToolDiagnostic(result);
  assert.deepEqual([diagnostic.stage, diagnostic.code, diagnostic.replyModelMatchesConfigured], ["model_check", "model_mismatch", false]);
  assert(!result.diagnostics[0]!.text.includes("MODEL_SECRET_SENTINEL"));
  assert.deepEqual((result.results[0] as { outcome: string }).outcome, "UNKNOWN");
});
