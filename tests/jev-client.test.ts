import assert from "node:assert/strict";
import test from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import { JevClient, type JevClientOptions } from "../packages/judgment/src/jev-client.js";

const fakeKey = "test-key-never-sent-to-a-provider";
const modelId = "operator-pinned-model-v1";
const choices = { approve: "Continue with the bounded action", reject: "Stop and request review" };
const success = {
  model: modelId,
  answers: { decision: { type: "choice", choice: "approve", confidence: 0.8, probabilities: { approve: 0.8, reject: 0.2 } } },
  usage: { input_tokens: 17, output_tokens: 3 },
};

function options(fetch: Fetch, overrides: Partial<JevClientOptions> = {}): JevClientOptions {
  return {
    apiKey: fakeKey,
    modelId,
    allowedModelIds: new Set([modelId]),
    limits: { maxInputBytes: 16_384, maxResponseBytes: 16_384, timeoutMs: 2_000 },
    fetch,
    ...overrides,
  };
}

function jsonFetch(reply: unknown, onRequest?: (input: string, init?: RequestInit) => void): Fetch {
  return async (input, init) => {
    onRequest?.(input, init);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("Jev client makes one bounded fixed-origin choice request and validates its result", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const client = new JevClient(options(jsonFetch(success, (input, init) => {
    calls += 1;
    assert.equal(input, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, modelId);
    assert.deepEqual(body.state, { task: "classify", evidence: ["sha256:fixture"] });
    assert.deepEqual(Object.keys(body.questions.decision.criteria), Object.keys(choices));
  })));

  const result = await client.choose({ state: { task: "classify", evidence: ["sha256:fixture"] }, choices }, signal);
  assert.deepEqual(result, { choice: "approve", model: modelId, usage: { inputTokens: 17, outputTokens: 3 }, confidence: 0.8 });
  assert.equal(calls, 1);
});

test("missing key, disallowed or moving model, invalid bounds, and oversized input fail before fetch", async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls += 1; return new Response(JSON.stringify(success)); };
  assert.throws(() => new JevClient(options(fetch, { apiKey: "" })), /API key configuration/);
  assert.throws(() => new JevClient(options(fetch, { modelId: "jev-latest" })), /operator-allowlisted exact ID/);
  assert.throws(() => new JevClient(options(fetch, { modelId: "not-allowed" })), /operator-allowlisted exact ID/);
  assert.throws(() => new JevClient(options(fetch, { limits: { maxInputBytes: 0, maxResponseBytes: 100, timeoutMs: 100 } })), /limits/);
  const client = new JevClient(options(fetch, { limits: { maxInputBytes: 8, maxResponseBytes: 4096, timeoutMs: 1000 } }));
  await assert.rejects(client.choose({ state: { task: "too large" }, choices }), /exceeds configured byte limit/);
  await assert.rejects(client.choose({ state: null, choices: { only: "one" } }), /between 2 and 32 choices/);
  await assert.rejects(client.choose({ state: null, choices: { "bad label": "invalid", stop: "Stop" } }), /identifiers or descriptions/);
  assert.equal(calls, 0);
});

test("unsafe SDK URL, non-POST, and over-limit request bodies never reach the injected transport", async () => {
  const seen: string[] = [];
  const guarded = options(async (input, init) => { seen.push(`${input}:${init?.method}`); return new Response(JSON.stringify(success)); });
  const client = new JevClient(guarded);
  const raw = client as unknown as { sdk: { fetch: Fetch } };
  await assert.rejects(raw.sdk.fetch("https://evil.invalid/v1/systemone", { method: "POST", body: "{}" }), /unexpected Jev request target/);
  await assert.rejects(raw.sdk.fetch("https://api.typesafe.ai/v1/models", { method: "GET" }), /unexpected Jev request target/);
  await assert.rejects(raw.sdk.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: "x".repeat(16_385) }), /request byte limit exceeded/);
  assert.deepEqual(seen, []);
});

test("invalid provider outputs become sanitized UNKNOWN and are never retried", async t => {
  const invalid = [
    { ...success, model: "unexpected-model" },
    { ...success, answers: { decision: { ...success.answers.decision, choice: "unauthorized" } } },
    { ...success, answers: { decision: { ...success.answers.decision, confidence: Number.NaN } } },
    { ...success, answers: { decision: { ...success.answers.decision, probabilities: { approve: 0.2, reject: 0.2 } } } },
    { ...success, usage: { input_tokens: -1, output_tokens: 3 } },
  ];
  for (const reply of invalid) {
    await t.test(`invalid response ${String(invalid.indexOf(reply) + 1)}`, async () => {
      let calls = 0;
      const client = new JevClient(options(jsonFetch(reply, () => { calls += 1; })));
      await assert.rejects(client.choose({ state: null, choices }), /invalid result; outcome is UNKNOWN/);
      assert.equal(calls, 1);
    });
  }
});

test("provider errors and oversized response bodies are redacted and make one attempt", async t => {
  await t.test("provider error text is not exposed", async () => {
    let calls = 0;
    const client = new JevClient(options(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: `bad request ${fakeKey}` }), { status: 500 });
    }));
    await assert.rejects(client.choose({ state: null, choices }), error => {
      assert.equal((error as Error).message, "Jev request failed after dispatch; outcome is UNKNOWN");
      assert.equal((error as Error).message.includes(fakeKey), false);
      return true;
    });
    assert.equal(calls, 1);
  });

  await t.test("response byte limit enforced while reading", async () => {
    let calls = 0;
    const client = new JevClient(options(async () => {
      calls += 1;
      return new Response("x".repeat(5000), { status: 200 });
    }, { limits: { maxInputBytes: 16_384, maxResponseBytes: 1024, timeoutMs: 1000 } }));
    await assert.rejects(client.choose({ state: null, choices }), /outcome is UNKNOWN/);
    assert.equal(calls, 1);
  });

  await t.test("timeout is sanitized and not retried", async () => {
    let calls = 0;
    const client = new JevClient(options(async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(`transport ${fakeKey}`)), { once: true });
      });
    }, { limits: { maxInputBytes: 16_384, maxResponseBytes: 16_384, timeoutMs: 40 } }));
    await assert.rejects(client.choose({ state: null, choices }), error => {
      assert.equal((error as Error).message, "Jev request failed after dispatch; outcome is UNKNOWN");
      assert.equal((error as Error).message.includes(fakeKey), false);
      return true;
    });
    assert.equal(calls, 1);
  });

  await t.test("wall-clock deadline bounds a fetch that ignores abort", async () => {
    let calls = 0;
    const client = new JevClient(options(async () => {
      calls += 1;
      return await new Promise<Response>(() => undefined);
    }, { limits: { maxInputBytes: 16_384, maxResponseBytes: 16_384, timeoutMs: 60 } }));
    const started = performance.now();
    await assert.rejects(client.choose({ state: null, choices }), /outcome is UNKNOWN/);
    assert.ok(performance.now() - started < 500, "the configured call deadline should bound the ignored abort");
    assert.equal(calls, 1);
  });

  await t.test("wall-clock deadline bounds a stalled response stream and does not await cancellation", async () => {
    let calls = 0;
    const client = new JevClient(options(async () => {
      calls += 1;
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => new Promise<void>(() => undefined),
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }, { limits: { maxInputBytes: 16_384, maxResponseBytes: 16_384, timeoutMs: 60 } }));
    const started = performance.now();
    await assert.rejects(client.choose({ state: null, choices }), /outcome is UNKNOWN/);
    assert.ok(performance.now() - started < 500, "the configured call deadline should bound stalled body reads");
    assert.equal(calls, 1);
  });
});
