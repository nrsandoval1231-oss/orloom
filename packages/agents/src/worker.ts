import { createHash } from "node:crypto";
import type {
  WorkerBlockedOrUnknownResult,
  WorkerExecutionLimits,
  WorkerLeaseContract,
  WorkerResult
} from "../../contracts/src/worker-protocol.js";

const sha = /^[a-f0-9]{40}$/i;
const digest = /^[a-f0-9]{64}$/i;
const maxText = 16_000;

export class WorkerProtocolError extends Error {}
export class ProviderOutcomeUnknown extends Error {}
class ProgressStop extends WorkerProtocolError {}

export function validateLease(value: unknown, now = Date.now()): WorkerLeaseContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerProtocolError("Invalid lease envelope");
  const lease = value as WorkerLeaseContract;
  if (lease.protocol !== "orloom.worker-lease.v1" || !lease.mission || !lease.slice || !lease.executionLimits) throw new WorkerProtocolError("Unsupported lease protocol");
  if (!lease.mission.id || !lease.slice.id || !lease.mission.repository || !sha.test(lease.mission.baseSha) || !digest.test(lease.planDigest) || !digest.test(lease.trustedCheckPolicyDigest)) throw new WorkerProtocolError("Invalid immutable lease identity");
  if (!Number.isSafeInteger(lease.leaseEpoch) || lease.leaseEpoch < 1 || !Number.isSafeInteger(lease.capacitySlot) || lease.capacitySlot < 1 || !lease.leaseToken || !lease.capabilityToken) throw new WorkerProtocolError("Invalid fenced lease identity");
  const expires = Date.parse(lease.leaseExpiresAt);
  if (!Number.isFinite(expires) || expires <= now) throw new WorkerProtocolError("Lease is expired");
  if (!Array.isArray(lease.slice.scopes) || !lease.slice.scopes.length || lease.slice.scopes.some(x => typeof x !== "string" || !x.trim())) throw new WorkerProtocolError("Lease has no valid owned scopes");
  const limits = lease.executionLimits;
  const positive = [limits.reservedBudgetCents, limits.maxProviderCalls, limits.maxInputTokens, limits.maxOutputTokens, limits.maxWallSeconds];
  if (positive.some(x => !Number.isSafeInteger(x) || x <= 0) || !Array.isArray(limits.allowedProviders) || !limits.allowedProviders.length || !Array.isArray(limits.allowedModels) || !limits.allowedModels.length) throw new WorkerProtocolError("Execution limits are not enabled");
  if (limits.allowedProviders.some(x => typeof x !== "string" || !x.trim()) || limits.allowedModels.some(x => typeof x !== "string" || !x.trim())) throw new WorkerProtocolError("Invalid provider allowlist");
  return lease;
}

export interface ControlPlane {
  claim(): Promise<WorkerLeaseContract | null>;
  cancellationRequested?(lease: WorkerLeaseContract): Promise<boolean>;
  heartbeat(lease: WorkerLeaseContract): Promise<void>;
  result(lease: WorkerLeaseContract, result: WorkerResult): Promise<void>;
}

export class HttpControlPlane implements ControlPlane {
  constructor(private readonly baseUrl: string, private readonly bootstrapToken: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !bootstrapToken) throw new WorkerProtocolError("Worker control endpoint must use HTTPS (except loopback tests), contain no URL credentials, and have a bootstrap token");
  }

  async claim(): Promise<WorkerLeaseContract | null> {
    const response = await this.fetcher(new URL("/api/worker/claim", this.baseUrl), { method: "POST", headers: this.bootstrapHeaders(), body: "{}", redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (response.status === 204) return null;
    if (!response.ok) throw new WorkerProtocolError(`Claim failed with HTTP ${response.status}`);
    return validateLease(await responseJson(response, 256_000));
  }

  async cancellationRequested(lease: WorkerLeaseContract): Promise<boolean> {
    const response = await this.call(lease, "cancellation", {});
    const value = await responseJson(response, 1024) as { requested?: unknown };
    if (typeof value?.requested !== "boolean") throw new WorkerProtocolError("Malformed cancellation status");
    return value.requested;
  }

  async heartbeat(lease: WorkerLeaseContract): Promise<void> {
    await this.call(lease, "heartbeat", {});
  }

  async result(lease: WorkerLeaseContract, result: WorkerResult): Promise<void> {
    const route = "outcome" in result ? "outcome" : "result";
    await this.call(lease, route, result);
  }

  private async call(lease: WorkerLeaseContract, route: string, body: unknown): Promise<Response> {
    const path = `/api/worker/missions/${encodeURIComponent(lease.mission.id)}/slices/${encodeURIComponent(lease.slice.id)}/${route}`;
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { ...this.bootstrapHeaders(), authorization: `Bearer ${lease.capabilityToken}`, "content-type": "application/json", "x-orloom-lease-token": lease.leaseToken, "x-orloom-lease-epoch": String(lease.leaseEpoch) },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new WorkerProtocolError(`${route} failed with HTTP ${response.status}`);
    return response;
  }

  private bootstrapHeaders() { return { authorization: `Bearer ${this.bootstrapToken}`, "content-type": "application/json" }; }
}

/** Serialized, fail-closed monitoring. Transport ambiguity stops local execution,
 * but does not claim owner cancellation or prove process termination. */
export function monitorCancellation(control: Pick<ControlPlane, "cancellationRequested">, lease: WorkerLeaseContract, controller: AbortController, intervalMs = 1_000): { ready: Promise<void>; stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const poll = async () => {
    try { if (await control.cancellationRequested?.(lease)) controller.abort(); }
    catch { controller.abort(); }
    if (!stopped && !controller.signal.aborted && control.cancellationRequested) timer = setTimeout(() => { pending = poll(); }, intervalMs);
  };
  pending = poll();
  return { ready: pending, async stop() { stopped = true; if (timer) clearTimeout(timer); await pending; } };
}

export interface DeepSeekMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: DeepSeekToolCall[]; }
export interface DeepSeekToolCall { id: string; type: "function"; function: { name: string; arguments: string }; }
export interface DeepSeekReply { model: string; messages: DeepSeekMessage[]; inputTokens: number; outputTokens: number; calls: number; }
export interface DeepSeekClient { listModels(signal?: AbortSignal): Promise<string[]>; probeTools(model: string, signal: AbortSignal): Promise<{ model: string; inputTokens: number; outputTokens: number }>; complete(model: string, messages: DeepSeekMessage[], signal: AbortSignal, maxOutputTokens: number): Promise<{ model: string; message: DeepSeekMessage; inputTokens: number; outputTokens: number }>; }

/** Minimal official OpenAI-compatible DeepSeek transport. Reasoning is explicitly disabled and never returned to the caller. */
export class DeepSeekHttpClient implements DeepSeekClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch, private readonly base = "https://api.deepseek.com") {
    const url = new URL(base);
    if (!apiKey || url.protocol !== "https:" || url.hostname !== "api.deepseek.com" || url.username || url.password || url.port) throw new WorkerProtocolError("DeepSeek requires the fixed official HTTPS API host and configured credential");
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let response: Response;
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    try { response = await this.fetcher(new URL("/models", this.base), { headers: { authorization: `Bearer ${this.apiKey}` }, redirect: "error", signal: requestSignal }); }
    catch { throw new WorkerProtocolError("DeepSeek model identity probe failed before any billable completion"); }
    if (!response.ok) throw new WorkerProtocolError(`DeepSeek model identity probe failed with HTTP ${response.status}`);
    let body: { data?: Array<{ id?: unknown }> };
    try { body = await responseJson(response, 128_000); } catch { throw new WorkerProtocolError("DeepSeek model identity response is malformed"); }
    if (!Array.isArray(body.data)) throw new WorkerProtocolError("DeepSeek model response is malformed");
    return body.data.map(x => x && typeof x === "object" && typeof x.id === "string" ? x.id : null).filter((x): x is string => typeof x === "string");
  }

  async probeTools(model: string, signal: AbortSignal) {
    const reply = await this.post(model, PROBE_MESSAGES, signal, PROBE_TOOLS, { type: "function", function: { name: "orloom_tool_probe" } }, 16);
    const calls = reply.message.tool_calls;
    if (!calls || calls.length !== 1 || calls[0]?.function.name !== "orloom_tool_probe" || calls[0].function.arguments.length > 128) throw new ProviderOutcomeUnknown("Configured model/API mode did not return exactly one bounded capability probe call");
    let args: unknown;
    try { args = JSON.parse(calls[0].function.arguments); } catch { throw new ProviderOutcomeUnknown("Model capability probe arguments were malformed"); }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 || (args as { ok?: unknown }).ok !== true) throw new ProviderOutcomeUnknown("Model capability probe arguments were unexpected");
    return { model: reply.model, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
  }

  async complete(model: string, messages: DeepSeekMessage[], signal: AbortSignal, maxOutputTokens: number) {
    return this.post(model, messages, signal, TOOL_SCHEMAS, "auto", Math.min(4096, maxOutputTokens));
  }

  private async post(model: string, messages: DeepSeekMessage[], signal: AbortSignal, tools: unknown[], toolChoice: unknown, maxTokens: number) {
    let response: Response;
    try {
      response = await this.fetcher(new URL("/chat/completions", this.base), {
        method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, signal, redirect: "error",
        body: JSON.stringify({ model, messages, stream: false, thinking: { type: "disabled" }, tools, tool_choice: toolChoice, max_tokens: maxTokens })
      });
    } catch { throw new ProviderOutcomeUnknown("DeepSeek call outcome is unknown"); }
    if (!response.ok) throw new ProviderOutcomeUnknown(`DeepSeek completion failed with HTTP ${response.status}`);
    const body = await responseJson<{ model?: unknown; choices?: Array<{ message?: Record<string, unknown> }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }>(response, 256_000);
    const returnedModel = typeof body.model === "string" ? body.model : "";
    const raw = body.choices?.[0]?.message;
    const usage = body.usage;
    if (!returnedModel || !raw || !usage || !Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 0 || !Number.isSafeInteger(usage.completion_tokens) || Number(usage.completion_tokens) < 0) throw new ProviderOutcomeUnknown("DeepSeek completion omitted valid measured token usage");
    const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls.map(item => {
      const call = item as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof call.id !== "string" || call.type !== "function" || typeof call.function?.name !== "string" || typeof call.function.arguments !== "string") throw new ProviderOutcomeUnknown("Malformed DeepSeek tool call");
      return { id: call.id, type: "function" as const, function: { name: call.function.name, arguments: call.function.arguments } };
    }) : undefined;
    const message: DeepSeekMessage = { role: "assistant", content: typeof raw.content === "string" ? raw.content.slice(0, maxText) : null, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    return { model: returnedModel, message, inputTokens: Number(usage.prompt_tokens), outputTokens: Number(usage.completion_tokens) };
  }
}

const TOOL_SCHEMAS = [
  { type: "function", function: { name: "read_file", description: "Read a bounded UTF-8 file in the owned workspace", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "list_files", description: "List bounded files in a workspace directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "apply_patch", description: "Replace one exact text fragment in an owned regular file", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false } } },
  { type: "function", function: { name: "run_check", description: "Run one check ID from the operator trusted policy", parameters: { type: "object", properties: { checkId: { type: "string" } }, required: ["checkId"], additionalProperties: false } } }
];

const PROBE_MESSAGES: DeepSeekMessage[] = [
  { role: "system", content: "Return the requested function call exactly. This is a bounded capability probe; do not provide prose." },
  { role: "user", content: "Call orloom_tool_probe with {ok:true}." }
];
const PROBE_TOOLS = [{ type: "function", function: { name: "orloom_tool_probe", description: "Protocol capability probe; do not perform work", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } }];

/** UTF-8 request bytes conservatively bound visible input tokens; include framing allowance. */
function conservativeInputReservation(model: string, messages: DeepSeekMessage[], probe = false): number {
  const tools = probe ? PROBE_TOOLS : TOOL_SCHEMAS;
  const toolChoice = probe ? { type: "function", function: { name: "orloom_tool_probe" } } : "auto";
  const body = { model, messages, stream: false, thinking: { type: "disabled" }, tools, tool_choice: toolChoice, max_tokens: 1 };
  return Buffer.byteLength(JSON.stringify(body), "utf8") + 512;
}

async function responseJson<T>(response: Response, maxBytes: number): Promise<T> {
  if (!response.body) throw new ProviderOutcomeUnknown("Provider response body is absent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ProviderOutcomeUnknown("Provider response exceeds the configured byte limit"); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as T;
  } catch (error) {
    if (error instanceof ProviderOutcomeUnknown) throw error;
    throw new ProviderOutcomeUnknown("Provider returned malformed or interrupted JSON");
  } finally { reader.releaseLock(); }
}

export interface WorkerWorkspace {
  checkout(repository: string, baseSha: string, signal?: AbortSignal): Promise<void>;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  listFiles(path: string, signal?: AbortSignal): Promise<string[]>;
  replaceText(path: string, oldText: string, newText: string, signal?: AbortSignal): Promise<void>;
  runCheck(checkId: string, signal: AbortSignal): Promise<WorkerCheckExecution>;
  commitCandidate(signal?: AbortSignal): Promise<{ candidateSha: string; diff: Uint8Array; bundle: Uint8Array }>;
  close(): Promise<void>;
}
export interface WorkerEvidence { put(bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string }>; get(key: string): Promise<Uint8Array>; }
export interface WorkerRuntime {
  /** Must be a broker-controlled, credential-free, runsc workspace with fixed exec semantics. */
  create(lease: WorkerLeaseContract): Promise<WorkerWorkspace>;
}
export interface WorkerCheckCommand { executable: string; args: string[]; timeoutSeconds: number; }
export interface WorkerCheckExecution { exitCode: number; output: string; outputSha256: string; commandDigest: string; durationMs: number; imageRef: string; }
export interface WorkerPricingSnapshot {
  model: string;
  version: string;
  source: string;
  capturedAt: string;
  expiresAt: string;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  reasoningCentsPerMillion: number;
  safetyMultiplier: number;
}
export interface WorkerOptions { allowedModels: string[]; allowedProviders: string[]; trustedChecks: string[]; trustedCheckPolicyDigest: string; trustedCheckCommands: Record<string, WorkerCheckCommand>; sandboxImageRef: string; maxToolCalls: number; pricing: WorkerPricingSnapshot; }
export type WorkerProgressPhase = "provider-tool-probe" | "provider-completion" | "candidate" | "tool-read_file" | "tool-list_files" | "tool-apply_patch" | "tool-run_check";
export interface WorkerProgressEvent { eventId: string; leaseEpoch: number; ordinal: number; phase: WorkerProgressPhase; status: "started" | "completed"; missionId: string; sliceId: string; model: string; subjectId?: string; candidateSha?: string; providerCalls: number; inputTokens: number; outputTokens: number; artifactDigests: string[]; }
export interface WorkerProgressSink { append(lease: WorkerLeaseContract, event: WorkerProgressEvent): Promise<{ decision: "CONTINUE" | "STOP"; reference: string; digest: string }>; }
export class R2WorkerProgressSink implements WorkerProgressSink {
  constructor(private readonly store: WorkerEvidence) {}
  async append(_lease: WorkerLeaseContract, event: WorkerProgressEvent) {
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    const saved = await this.store.put(bytes, "application/json");
    const readback = await this.store.get(saved.key);
    const hash = createHash("sha256").update(readback).digest("hex");
    if (!/^sha256\/[a-f0-9]{64}$/.test(saved.key) || hash !== saved.sha256 || hash !== saved.key.slice(7)) throw new WorkerProtocolError("Progress event failed immutable store readback");
    return { decision: "CONTINUE" as const, reference: `${saved.key}:${saved.sha256}`, digest: saved.sha256 };
  }
}

function canonicalCheckCommands(commands: Record<string, WorkerCheckCommand>): Record<string, WorkerCheckCommand> {
  return Object.fromEntries(Object.keys(commands).sort().map(id => {
    const command = commands[id]!;
    const allowedExecutables = new Set(["node", "npm", "pnpm", "python3", "pytest", "ruff", "go", "cargo"]);
    if (!allowedExecutables.has(command.executable) || !Array.isArray(command.args) || command.args.length > 64 || command.args.some(arg => typeof arg !== "string" || arg.length > 500 || /(?:token|secret|password|api[_-]?key)/i.test(arg) || /-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/.test(arg)) || !Number.isSafeInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 300) throw new WorkerProtocolError("Trusted check argv is outside the bounded secret-free policy");
    return [id, { executable: command.executable, args: [...command.args], timeoutSeconds: command.timeoutSeconds }];
  }));
}

function checkCommandDigest(command: WorkerCheckCommand): string {
  return createHash("sha256").update(JSON.stringify({ executable: command.executable, args: command.args, timeoutSeconds: command.timeoutSeconds })).digest("hex");
}

function matchesScope(value: string, scope: string): boolean {
  if (typeof scope !== "string" || !scope.trim() || /[\u0000-\u001f\u007f]/.test(scope) || scope.includes("\\") || scope.startsWith("/") || scope.split("/").some(x => x === ".." || x === ".git")) return false;
  if (!scope.includes("*")) return value === scope || value.startsWith(`${scope.replace(/\/$/, "")}/`);
  const pattern = scope.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`).test(value);
}

export function assertWorkerScopePath(value: string, scopes: string[]): string {
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\") || value.startsWith("/") || value.split("/").some(x => !x || x === "." || x === ".." || x === ".git")) throw new WorkerProtocolError("Tool path is not a normalized workspace-relative path");
  if (!scopes.some(scope => matchesScope(value, scope))) throw new WorkerProtocolError("Tool path is outside the slice scopes");
  return value;
}

function withinScope(path: string, scopes: string[]): string { return assertWorkerScopePath(path, scopes); }

function sanitized(text: string): string {
  return text.replace(/(bearer\s+)[^\s"']+/gi, "$1[redacted]").replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s"']+/gi, "$1$2[redacted]").slice(0, maxText);
}

export async function executeLease(leaseInput: unknown, deps: { control: ControlPlane; provider: DeepSeekClient; runtime: WorkerRuntime; evidence: WorkerEvidence; progress: WorkerProgressSink; checks: Record<string, readonly string[]>; options: WorkerOptions; now?: () => number }): Promise<void> {
  const lease = validateLease(leaseInput, (deps.now ?? Date.now)());
  try {
    await executeValidatedLease(lease, deps);
  } catch {
    // Preflight failures occur before an uncertain provider operation; report a durable BLOCKED result.
    try { await deps.control.result(lease, { outcome: "BLOCKED", reasonCode: "other", evidenceRefs: [] }); } catch { /* unresolved control-plane failure remains UNKNOWN */ }
  }
}

async function executeValidatedLease(leaseInput: WorkerLeaseContract, deps: { control: ControlPlane; provider: DeepSeekClient; runtime: WorkerRuntime; evidence: WorkerEvidence; progress: WorkerProgressSink; checks: Record<string, readonly string[]>; options: WorkerOptions; now?: () => number }): Promise<void> {
  const now = deps.now ?? Date.now;
  const lease = leaseInput;
  const limits: WorkerExecutionLimits = lease.executionLimits;
  const started = now();
  const deadline = Math.min(Date.parse(lease.leaseExpiresAt), started + limits.maxWallSeconds * 1000);
  const preflightSignal = AbortSignal.timeout(Math.max(1, deadline - now()));
  const policyDigest = createHash("sha256").update(JSON.stringify(deps.options.trustedChecks)).digest("hex");
  if (policyDigest !== lease.trustedCheckPolicyDigest || policyDigest !== deps.options.trustedCheckPolicyDigest) throw new WorkerProtocolError("Trusted check policy digest does not match the lease");
  if (Object.keys(deps.options.trustedCheckCommands).sort().join("\n") !== [...deps.options.trustedChecks].sort().join("\n")) throw new WorkerProtocolError("Trusted check command snapshot does not match the leased check IDs");
  if (!/^sha256:[a-f0-9]{64}$/i.test(deps.options.sandboxImageRef) && !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/i.test(deps.options.sandboxImageRef)) throw new WorkerProtocolError("Sandbox image must be an immutable configured content ID or registry digest");
  const checkSnapshot = canonicalCheckCommands(deps.options.trustedCheckCommands);
  const checkCommandsDigest = createHash("sha256").update(JSON.stringify(checkSnapshot)).digest("hex");
  if (!Number.isSafeInteger(deps.options.maxToolCalls) || deps.options.maxToolCalls < 1) throw new WorkerProtocolError("Local tool call cap is not enabled");
  if (!deps.options.allowedProviders.includes("deepseek") || !limits.allowedProviders.includes("deepseek")) throw new WorkerProtocolError("DeepSeek provider is not enabled by both operator and lease policy");
  if (!deps.options.allowedModels.length || !deps.options.allowedModels.some(model => limits.allowedModels.includes(model))) throw new WorkerProtocolError("No exact model is enabled by both operator and lease policy");
  const providerModels = await deps.provider.listModels(preflightSignal);
  const model = deps.options.allowedModels.find(x => limits.allowedModels.includes(x) && providerModels.includes(x));
  if (!model) throw new WorkerProtocolError("No configured exact model was returned by DeepSeek /models");
  const pricing = Object.freeze({ ...deps.options.pricing });
  const pricingDigest = createHash("sha256").update(JSON.stringify(pricing)).digest("hex");
  const capturedAt = Date.parse(pricing.capturedAt), expiresAt = Date.parse(pricing.expiresAt);
  if (pricing.model !== model || !pricing.version || !pricing.source || !Number.isFinite(capturedAt) || capturedAt > now() || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt <= capturedAt || [pricing.inputCentsPerMillion, pricing.outputCentsPerMillion, pricing.reasoningCentsPerMillion].some(x => !Number.isFinite(x) || x <= 0) || !Number.isFinite(pricing.safetyMultiplier) || pricing.safetyMultiplier < 1.2) throw new WorkerProtocolError("Trusted model pricing is unavailable, stale, or invalid");
  const worstCaseCost = Math.ceil(((limits.maxInputTokens * pricing.inputCentsPerMillion + limits.maxOutputTokens * Math.max(pricing.outputCentsPerMillion, pricing.reasoningCentsPerMillion)) / 1_000_000) * pricing.safetyMultiplier);
  if (worstCaseCost > limits.reservedBudgetCents) throw new WorkerProtocolError("Worst-case provider spend exceeds the slice reservation");
  const assertPricingCurrent = () => {
    if (now() >= expiresAt || now() >= deadline) throw new WorkerProtocolError("Pricing snapshot or lease expired before the next billable provider call");
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - now()));
  let workspace: WorkerWorkspace | undefined;
  const evidenceEntries: Array<{ name: string; key: string; sha256: string; reference: string }> = [];
  const progressEntries: Array<{ reference: string; digest: string }> = [];
  const saveEvidence = async (name: string, bytes: Uint8Array, contentType: string) => {
    const out = await deps.evidence.put(bytes, contentType);
    const verified = await deps.evidence.get(out.key);
    const hash = createHash("sha256").update(verified).digest("hex");
    if (hash !== out.sha256 || hash !== out.key.slice(7)) throw new WorkerProtocolError("Evidence readback digest mismatch");
    evidenceEntries.push({ name, key: out.key, sha256: hash, reference: `${name}:${out.key}` });
  };
  const terminalEvidenceRefs = () => {
    const preferred = ["candidate-bundle", "candidate-diff", "evidence-index", "provider-usage", "sandbox-policy"];
    return [...new Set(preferred.flatMap(name => evidenceEntries.filter(entry => entry.name === name).map(entry => entry.reference)))].slice(0, 10);
  };
  const saveEvidenceIndex = async () => {
    const index = { version: "orloom.worker-evidence-index.v1", missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, baseSha: lease.mission.baseSha, planDigest: lease.planDigest, trustedCheckPolicyDigest: lease.trustedCheckPolicyDigest, entries: [...evidenceEntries, ...progressEntries.map(entry => ({ name: "progress", reference: entry.reference, sha256: entry.digest }))] };
    await saveEvidence("evidence-index", new TextEncoder().encode(JSON.stringify(index)), "application/json");
  };
  const recordProviderAttempt = async (index: number, phase: string) => {
    const data = JSON.stringify({ kind: "provider-attempt", index, phase, model, missionId: lease.mission.id, sliceId: lease.slice.id, epoch: lease.leaseEpoch, planDigest: lease.planDigest, policyDigest: lease.trustedCheckPolicyDigest, pricingDigest, maxCalls: limits.maxProviderCalls, maxInputTokens: limits.maxInputTokens, maxOutputTokens: limits.maxOutputTokens, reservedBudgetCents: limits.reservedBudgetCents });
    await saveEvidence(`provider-attempt-${index}`, new TextEncoder().encode(data), "application/json");
  };
  await saveEvidence("pricing-snapshot", new TextEncoder().encode(JSON.stringify({ ...pricing, digest: pricingDigest })), "application/json");
  await saveEvidence("sandbox-policy", new TextEncoder().encode(JSON.stringify({ missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, baseSha: lease.mission.baseSha, planDigest: lease.planDigest, trustedCheckPolicyDigest: lease.trustedCheckPolicyDigest, checkCommandsDigest, checkCommands: checkSnapshot, sandboxImageRef: deps.options.sandboxImageRef })), "application/json");
  let calls = 0, inputTokens = 0, outputTokens = 0, toolsRun = 0;
  let terminalAttempted = false;
  let progressOrdinal = 0;
  const emit = async (phase: WorkerProgressPhase, status: WorkerProgressEvent["status"], subjectId?: string, candidateSha?: string) => {
    const ordinal = ++progressOrdinal;
    const eventId = createHash("sha256").update(`${lease.mission.id}\n${lease.slice.id}\n${lease.leaseEpoch}\n${ordinal}\n${phase}\n${status}`).digest("hex");
    if (!["started", "completed"].includes(status)) throw new WorkerProtocolError("Progress event status is outside the fixed protocol");
    const response = await deps.progress.append(lease, { eventId, leaseEpoch: lease.leaseEpoch, ordinal, phase, status, missionId: lease.mission.id, sliceId: lease.slice.id, model, ...(subjectId && lease.slice.checks.includes(subjectId) ? { subjectId } : {}), ...(candidateSha && sha.test(candidateSha) ? { candidateSha } : {}), providerCalls: calls, inputTokens, outputTokens, artifactDigests: [...evidenceEntries.map(entry => entry.sha256), ...progressEntries.map(entry => entry.digest)] });
    const reference = /^(sha256\/[a-f0-9]{64}):([a-f0-9]{64})$/.exec(response.reference);
    if (!reference || reference[2] !== response.digest || reference[1] !== `sha256/${response.digest}`) throw new WorkerProtocolError("Progress sink returned an invalid structured reference");
    progressEntries.push({ reference: response.reference, digest: response.digest });
    if (response.decision === "STOP") throw new ProgressStop("Durable policy requested stop at a safe boundary");
  };
  const cancellation = monitorCancellation(deps.control, lease, controller);
  const heartbeatTimer = setInterval(() => { void deps.control.heartbeat(lease).catch(() => controller.abort()); }, 30_000);
  try {
    await cancellation.ready;
    if (controller.signal.aborted) throw new Error("WORKER_CANCELLATION_UNKNOWN");
    workspace = await deps.runtime.create(lease);
    await workspace.checkout(lease.mission.repository, lease.mission.baseSha, controller.signal);
    if (limits.maxOutputTokens < 16 || calls >= limits.maxProviderCalls || conservativeInputReservation(model, PROBE_MESSAGES, true) > limits.maxInputTokens - inputTokens) throw new WorkerProtocolError("Mandatory tool probe does not fit the remaining execution limits");
    await recordProviderAttempt(1, "tool-capability-probe");
    await emit("provider-tool-probe", "started");
    if (controller.signal.aborted) throw new Error("WORKER_CANCELLATION_UNKNOWN");
    assertPricingCurrent();
    const probe = await deps.provider.probeTools(model, controller.signal);
    calls++;
    inputTokens += probe.inputTokens;
    outputTokens += probe.outputTokens;
    await saveEvidence("provider-usage-probe", new TextEncoder().encode(JSON.stringify({ model, calls, inputTokens, outputTokens, pricing, pricingDigest })), "application/json");
    await emit("provider-tool-probe", "completed");
    if (probe.model !== model || calls > limits.maxProviderCalls || inputTokens > limits.maxInputTokens || outputTokens > limits.maxOutputTokens) throw new ProviderOutcomeUnknown("Tool protocol probe exceeded the configured model or execution limits");
    const messages: DeepSeekMessage[] = [
      { role: "system", content: `You are a bounded code builder. Work only in the exact checkout and slice scopes. Use only read_file, list_files, apply_patch, and run_check. No shell, network, credentials, provider policy, verification, integration, or deployment authority. Candidate base is ${lease.mission.baseSha}. Owned scopes: ${lease.slice.scopes.join(", ")}.` },
      { role: "user", content: `Mission: ${lease.mission.objective}\nSlice: ${lease.slice.objective}\nAcceptance: ${lease.mission.acceptance.join("\n")}\nCheck IDs: ${lease.slice.checks.join(", ")}` }
    ];
    for (;;) {
      if (controller.signal.aborted || now() >= deadline) throw new Error("WORKER_DEADLINE_UNKNOWN");
      if (calls >= limits.maxProviderCalls) throw new Error("WORKER_BUDGET_EXHAUSTED");
      const remainingOutput = limits.maxOutputTokens - outputTokens;
      if (remainingOutput <= 0) throw new Error("WORKER_BUDGET_EXHAUSTED");
      if (conservativeInputReservation(model, messages) > limits.maxInputTokens - inputTokens) throw new WorkerProtocolError("Provider request does not fit the remaining input-token reservation");
      await recordProviderAttempt(calls + 1, "tool-loop");
      await emit("provider-completion", "started");
      if (controller.signal.aborted) throw new Error("WORKER_CANCELLATION_UNKNOWN");
      assertPricingCurrent();
      const reply = await deps.provider.complete(model, messages, controller.signal, remainingOutput);
      calls++;
      inputTokens += reply.inputTokens;
      outputTokens += reply.outputTokens;
      await saveEvidence(`provider-usage-${calls}`, new TextEncoder().encode(JSON.stringify({ model, calls, inputTokens, outputTokens, pricing, pricingDigest })), "application/json");
      await emit("provider-completion", "completed");
      if (reply.model !== model) throw new ProviderOutcomeUnknown("DeepSeek returned an unexpected model ID");
      if (inputTokens > limits.maxInputTokens || outputTokens > limits.maxOutputTokens || now() - started > limits.maxWallSeconds * 1000) throw new Error("WORKER_BUDGET_EXHAUSTED");
      const assistant: DeepSeekMessage = { role: "assistant", content: reply.message.content, ...(reply.message.tool_calls ? { tool_calls: reply.message.tool_calls } : {}) };
      messages.push(assistant);
      const tools = reply.message.tool_calls ?? [];
      if (!tools.length) break;
      if (tools.length > deps.options.maxToolCalls - toolsRun) throw new ProviderOutcomeUnknown("Provider returned more function calls than the local execution cap");
      const prepared = tools.map(tool => ({ tool, args: parseToolArguments(tool) }));
      const callIds = new Set<string>();
      for (const { tool, args } of prepared) {
        if (!tool.id || callIds.has(tool.id)) throw new ProviderOutcomeUnknown("Provider returned missing or duplicate tool call IDs");
        callIds.add(tool.id);
        validateToolCall(tool, args, lease);
      }
      for (const { tool, args: parsedArgs } of prepared) {
        if (controller.signal.aborted) throw new Error("WORKER_DEADLINE_UNKNOWN");
        toolsRun++;
        const subjectId = tool.function.name === "run_check" && typeof parsedArgs.checkId === "string" ? parsedArgs.checkId : undefined;
        await emit(toolProgressPhase(tool.function.name), "started", subjectId);
        const result = await runTool(tool, workspace, lease, deps, controller.signal, parsedArgs);
        if (tool.function.name === "run_check" && subjectId) {
          const check = result as WorkerCheckExecution;
          await saveEvidence(`check-${subjectId}`, new TextEncoder().encode(JSON.stringify({ missionId: lease.mission.id, sliceId: lease.slice.id, leaseEpoch: lease.leaseEpoch, baseSha: lease.mission.baseSha, candidateSha: null, checkId: subjectId, commandDigest: check.commandDigest, checkCommandsDigest, exitCode: check.exitCode, durationMs: check.durationMs, outputSha256: check.outputSha256, imageRef: check.imageRef, trustedCheckPolicyDigest: lease.trustedCheckPolicyDigest })), "application/json");
        }
        await emit(toolProgressPhase(tool.function.name), "completed", subjectId);
        messages.push({ role: "tool", tool_call_id: tool.id, content: sanitized(JSON.stringify(result)) });
      }
    }
    if (controller.signal.aborted) throw new Error("WORKER_CANCELLATION_UNKNOWN");
    await emit("candidate", "started");
    const candidate = await workspace.commitCandidate(controller.signal);
    if (!sha.test(candidate.candidateSha)) throw new WorkerProtocolError("Workspace returned an invalid candidate SHA");
    if (!(candidate.bundle instanceof Uint8Array) || candidate.bundle.byteLength === 0) throw new WorkerProtocolError("Workspace did not return a durable candidate Git bundle");
    await saveEvidence("candidate-diff", candidate.diff, "text/x-diff");
    await saveEvidence("candidate-bundle", candidate.bundle, "application/vnd.git.bundle");
    await emit("candidate", "completed", undefined, candidate.candidateSha);
    const costCents = Math.ceil(((inputTokens * pricing.inputCentsPerMillion + outputTokens * Math.max(pricing.outputCentsPerMillion, pricing.reasoningCentsPerMillion)) / 1_000_000) * pricing.safetyMultiplier);
    if (costCents > limits.reservedBudgetCents) throw new ProviderOutcomeUnknown("Measured provider spend exceeded the slice reservation");
    const usage = JSON.stringify({ model, providerCalls: calls, inputTokens, outputTokens, costCents, pricing, pricingDigest, elapsedMs: Math.max(0, now() - started), planDigest: lease.planDigest, policyDigest: lease.trustedCheckPolicyDigest });
    await saveEvidence("provider-usage", new TextEncoder().encode(usage), "application/json");
    await saveEvidenceIndex();
    if (workspace) { const closing = workspace; workspace = undefined; await closing.close(); }
    if (controller.signal.aborted) throw new Error("WORKER_CANCELLATION_UNKNOWN");
    terminalAttempted = true;
    await deps.control.result(lease, { candidateSha: candidate.candidateSha, evidenceRefs: terminalEvidenceRefs() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker_failure";
    let cleanupUncertain = false;
    if (workspace) {
      const closing = workspace;
      workspace = undefined;
      try { await closing.close(); } catch { cleanupUncertain = true; }
    }
    const unknown = cleanupUncertain || message.includes("UNKNOWN") || controller.signal.aborted || error instanceof ProviderOutcomeUnknown || !(error instanceof WorkerProtocolError);
    try { await saveEvidenceIndex(); } catch { /* terminal refs below still retain bounded direct artifacts */ }
    const outcome: WorkerBlockedOrUnknownResult = { outcome: unknown ? "UNKNOWN" : "BLOCKED", reasonCode: message.includes("BUDGET") ? "budget_exhausted" : message.includes("SCOPE") ? "scope_conflict" : unknown ? "provider_unavailable" : "other", evidenceRefs: terminalEvidenceRefs() };
    if (!terminalAttempted) {
      terminalAttempted = true;
      try { await deps.control.result(lease, outcome); } catch { /* durable control-plane failure remains unresolved; never retry blindly */ }
    }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeatTimer);
    await cancellation.stop();
    if (workspace) { const closing = workspace; workspace = undefined; await closing.close(); }
  }
}

function parseToolArguments(tool: DeepSeekToolCall): Record<string, unknown> {
  if (tool.function.arguments.length > 8_000) throw new WorkerProtocolError("Tool arguments exceed the bound");
  let args: unknown;
  try { args = JSON.parse(tool.function.arguments); } catch { throw new WorkerProtocolError("Tool arguments are malformed JSON"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new WorkerProtocolError("Tool arguments must be an object");
  return args as Record<string, unknown>;
}

function validateToolCall(tool: DeepSeekToolCall, args: Record<string, unknown>, lease: WorkerLeaseContract): void {
  const keys = Object.keys(args);
  if (tool.function.name === "read_file" || tool.function.name === "list_files") {
    if (keys.length !== 1 || keys[0] !== "path" || typeof args.path !== "string") throw new WorkerProtocolError("File tool arguments are invalid");
    assertWorkerScopePath(args.path, lease.slice.scopes);
    return;
  }
  if (tool.function.name === "apply_patch") {
    if (keys.length !== 3 || keys.some(key => !["path", "oldText", "newText"].includes(key)) || typeof args.path !== "string" || typeof args.oldText !== "string" || typeof args.newText !== "string" || !args.oldText || args.oldText.length > 8_000 || args.newText.length > 8_000) throw new WorkerProtocolError("Patch arguments are invalid");
    assertWorkerScopePath(args.path, lease.slice.scopes);
    return;
  }
  if (tool.function.name === "run_check") {
    if (keys.length !== 1 || keys[0] !== "checkId" || typeof args.checkId !== "string" || !lease.slice.checks.includes(args.checkId)) throw new WorkerProtocolError("Check is not bound to the lease policy");
    return;
  }
  throw new WorkerProtocolError("Unknown tool function");
}

function toolProgressPhase(name: string): WorkerProgressPhase {
  switch (name) {
    case "read_file": return "tool-read_file";
    case "list_files": return "tool-list_files";
    case "apply_patch": return "tool-apply_patch";
    case "run_check": return "tool-run_check";
    default: throw new WorkerProtocolError("Unknown tool function");
  }
}

async function runTool(tool: DeepSeekToolCall, workspace: WorkerWorkspace, lease: WorkerLeaseContract, deps: { checks: Record<string, readonly string[]>; options: WorkerOptions }, signal: AbortSignal, a = parseToolArguments(tool)): Promise<unknown> {
  switch (tool.function.name) {
    case "read_file": {
      if (Object.keys(a).some(x => x !== "path")) throw new WorkerProtocolError("Unexpected read_file argument");
      const path = withinScope(a.path as string, lease.slice.scopes);
      const text = await workspace.readFile(path, signal);
      if (text.length > maxText) throw new WorkerProtocolError("File exceeds model context limit");
      return { text: sanitized(text) };
    }
    case "list_files": {
      if (Object.keys(a).some(x => x !== "path")) throw new WorkerProtocolError("Unexpected list_files argument");
      const path = withinScope(a.path as string, lease.slice.scopes);
      return { files: (await workspace.listFiles(path, signal)).slice(0, 500).map(x => withinScope(x, lease.slice.scopes)) };
    }
    case "apply_patch": {
      if (Object.keys(a).some(x => !["path", "oldText", "newText"].includes(x))) throw new WorkerProtocolError("Unexpected apply_patch argument");
      const path = withinScope(a.path as string, lease.slice.scopes);
      if (typeof a.oldText !== "string" || typeof a.newText !== "string" || !a.oldText || a.oldText.length > 8_000 || a.newText.length > 8_000) throw new WorkerProtocolError("Patch arguments are invalid");
      const oldText = await workspace.readFile(path, signal);
      if (oldText.split(a.oldText).length !== 2) throw new WorkerProtocolError("Patch context must match exactly once");
      await workspace.replaceText(path, a.oldText, a.newText, signal);
      return { updated: true, path };
    }
    case "run_check": {
      if (Object.keys(a).some(x => x !== "checkId")) throw new WorkerProtocolError("Unexpected run_check argument");
      if (typeof a.checkId !== "string" || !lease.slice.checks.includes(a.checkId) || !deps.checks[a.checkId]) throw new WorkerProtocolError("Check is not bound to the trusted check policy");
      const output = await workspace.runCheck(a.checkId, signal);
      const command = deps.options.trustedCheckCommands[a.checkId];
      if (!command) throw new WorkerProtocolError("Trusted check command is missing from the immutable policy snapshot");
      if (!Number.isSafeInteger(output.exitCode) || !Number.isSafeInteger(output.durationMs) || output.durationMs < 0 || !digest.test(output.outputSha256) || !digest.test(output.commandDigest) || output.commandDigest !== checkCommandDigest(command) || output.imageRef !== deps.options.sandboxImageRef) throw new WorkerProtocolError("Sandbox check evidence does not match its trusted command and image snapshot");
      return { ...output, output: sanitized(output.output) };
    }
    default: throw new WorkerProtocolError("Unknown tool function");
  }
}
