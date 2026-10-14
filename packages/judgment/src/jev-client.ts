import {
  choice,
  TypeSafeClient,
  type EntryType,
  type Fetch,
  type Usage,
} from "@typesafe-ai/sdk";

const API_ORIGIN = "https://api.typesafe.ai";
const SYSTEM_ONE_PATH = "/v1/systemone";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface JevLimits {
  maxInputBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface JevClientOptions {
  apiKey?: string;
  modelId?: string;
  allowedModelIds: ReadonlySet<string>;
  limits: JevLimits;
  /** Injected transport for deterministic tests or a trusted host transport. */
  fetch?: Fetch;
}

export interface JevChoiceRequest {
  state: EntryType;
  choices: Readonly<Record<string, string>>;
}

export interface JevChoiceResult {
  choice: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  confidence: number;
}

class RequestLimitError extends Error {}
const ABORTED = Symbol("jev-call-aborted");

function validPositiveLimit(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function validateOptions(options: JevClientOptions): { apiKey: string; modelId: string } {
  const apiKey = options.apiKey;
  if (!apiKey || apiKey.length > 8192 || !/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error("Jev API key configuration is missing or invalid");
  }
  const modelId = options.modelId;
  if (!modelId || modelId !== modelId.trim() || modelId === "jev-latest" || !options.allowedModelIds?.has(modelId)) {
    throw new Error("Jev model must be an operator-allowlisted exact ID");
  }
  if (!validPositiveLimit(options.limits?.maxInputBytes, 1_000_000)
    || !validPositiveLimit(options.limits?.maxResponseBytes, 1_000_000)
    || !validPositiveLimit(options.limits?.timeoutMs, 60_000)) {
    throw new Error("Jev request limits are missing or invalid");
  }
  return { apiKey, modelId };
}

function validateChoices(choices: Readonly<Record<string, string>>): string[] {
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
    throw new Error("Jev choices must be a named object");
  }
  const labels = Object.keys(choices);
  if (labels.length < 2 || labels.length > 32) throw new Error("Jev requires between 2 and 32 choices");
  for (const label of labels) {
    const description = choices[label];
    if (!LABEL.test(label) || label === "constructor" || label === "prototype" || typeof description !== "string"
      || description.trim().length === 0 || description.length > 1000) {
      throw new Error("Jev choice identifiers or descriptions are invalid");
    }
  }
  return labels;
}

function assertUsage(usage: Usage): JevChoiceResult["usage"] {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new Error("invalid usage");
  }
  return { inputTokens, outputTokens };
}

function assertChoiceAnswer(value: unknown, labels: string[]): { choice: string; confidence: number } {
  if (!value || typeof value !== "object") throw new Error("invalid choice answer");
  const answer = value as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !labels.includes(answer.choice)
    || typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1
    || !answer.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw new Error("invalid choice answer");
  }
  const probabilities = answer.probabilities as Record<string, unknown>;
  const keys = Object.keys(probabilities);
  if (keys.length !== labels.length || labels.some(label => !Object.hasOwn(probabilities, label))) {
    throw new Error("invalid choice probability shape");
  }
  const values = keys.map(key => probabilities[key]);
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("invalid choice probability values");
  }
  const sum = (values as number[]).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.02) throw new Error("invalid choice probability total");
  return { choice: answer.choice, confidence: answer.confidence };
}

function byteLength(value: EntryType): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { throw new Error("Jev state must be bounded JSON"); }
}

function boundedFetch(baseFetch: Fetch, maxRequestBytes: number, maxResponseBytes: number): Fetch {
  return async (input, init) => {
    let target: URL;
    try { target = new URL(input); }
    catch { throw new Error("unexpected Jev request URL"); }
    if (target.origin !== API_ORIGIN || target.pathname !== SYSTEM_ONE_PATH || target.search || target.hash
      || target.username || target.password || (init?.method ?? "GET").toUpperCase() !== "POST") {
      throw new Error("unexpected Jev request target");
    }
    const body = init?.body;
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > maxRequestBytes) {
      throw new RequestLimitError("request byte limit exceeded");
    }
    const response = await baseFetch(target.toString(), { ...init, redirect: "error" });
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxResponseBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("response byte limit exceeded");
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancelReader = () => { void reader.cancel().catch(() => undefined); };
    init?.signal?.addEventListener("abort", cancelReader, { once: true });
    if (init?.signal?.aborted) cancelReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          cancelReader();
          throw new Error("response byte limit exceeded");
        }
        chunks.push(value);
      }
    } finally {
      init?.signal?.removeEventListener("abort", cancelReader);
      try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const responseBody = response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes;
    return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class JevClient {
  private readonly sdk: TypeSafeClient;
  private readonly modelId: string;
  private readonly limits: JevLimits;

  constructor(options: JevClientOptions) {
    const { apiKey, modelId } = validateOptions(options);
    this.modelId = modelId;
    this.limits = { ...options.limits };
    this.sdk = new TypeSafeClient({
      apiKey,
      baseURL: API_ORIGIN,
      defaultModel: modelId,
      timeout: this.limits.timeoutMs,
      retry: { maxRetries: 0, apiConnectionError: false, apiTimeoutError: false },
      logLevel: "off",
      fetch: boundedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), this.limits.maxInputBytes, this.limits.maxResponseBytes),
    });
  }

  async choose(request: JevChoiceRequest, signal?: AbortSignal): Promise<JevChoiceResult> {
    if (!request || typeof request !== "object" || !("state" in request) || !("choices" in request)) {
      throw new Error("Jev choice request is invalid");
    }
    const labels = validateChoices(request.choices);
    if (byteLength(request.state) > this.limits.maxInputBytes) throw new Error("Jev state exceeds configured byte limit");
    if (signal?.aborted) throw new Error("Jev request cancelled before dispatch");
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", relayAbort);
      throw new Error("Jev request cancelled before dispatch");
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(ABORTED);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const deadline = setTimeout(relayAbort, this.limits.timeoutMs);
    let result;
    try {
      const dispatched = this.sdk.systemOne({
        model: this.modelId,
        state: request.state,
        questions: { decision: choice("Select the best matching authorized choice.", request.choices) },
      }, {
        signal: controller.signal,
        timeout: this.limits.timeoutMs,
        retry: { maxRetries: 0, apiConnectionError: false, apiTimeoutError: false },
      });
      result = await Promise.race([dispatched, aborted]);
    } catch (error) {
      if (error instanceof RequestLimitError) throw new Error("Jev request exceeds configured byte limit");
      if (error === ABORTED) throw new Error("Jev request failed after dispatch; outcome is UNKNOWN");
      throw new Error("Jev request failed after dispatch; outcome is UNKNOWN");
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", relayAbort);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
    try {
      if (result.model !== this.modelId) throw new Error("model mismatch");
      const answer = assertChoiceAnswer(result.answers?.decision, labels);
      const usage = assertUsage(result.usage);
      return { ...answer, model: this.modelId, usage };
    } catch {
      throw new Error("Jev returned an invalid result; outcome is UNKNOWN");
    }
  }
}
