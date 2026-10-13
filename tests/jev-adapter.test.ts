import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import { JevClient } from "../packages/judgment/src/jev-client.js";
import { createJevRecoveryAdapter } from "../packages/judgment/src/jev-adapter.js";
import type { DecisionSnapshotV1 } from "../packages/judgment/src/types.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";

test("Jev recovery adapter exposes only approved alternative IDs and binds the answer to the snapshot", async () => {
  const modelId = "operator-pinned-model-v1";
  let observedBody: Record<string, any> | undefined;
  const fetch: Fetch = async (_input, init) => {
    observedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      model: modelId,
      answers: { decision: { type: "choice", choice: "strategy_1", confidence: 0.75, probabilities: { escalate: 0.25, strategy_1: 0.75 } } },
      usage: { input_tokens: 20, output_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new JevClient({ apiKey: "injected-test-key", modelId, allowedModelIds: new Set([modelId]), limits: { maxInputBytes: 16_384, maxResponseBytes: 16_384, timeoutMs: 1000 }, fetch });
  const snapshot: DecisionSnapshotV1 = {
    version: "orloom.decision-snapshot.v1", missionId: "mission", sliceId: "slice", leaseEpoch: 1, revision: 1,
    planDigest: "a".repeat(64), trustedCheckPolicyDigest: "b".repeat(64), recoveryPolicyDigest: "c".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), eventId: "event-1", targetCheckId: "target:build",
    status: "failed", reasonCode: "check_failed", strategyId: "strategy:baseline", checkId: "check:baseline",
    triedStrategies: ["strategy:baseline"], alternatives: [{ id: "strategy:recovery", policy: { checkId: "check:recovery", version: "v1", expectedSignal: "fixture passes", scopeClasses: ["src"], targetCheckIds: ["target:build"] } }],
    lessonIds: [], lessonBindings: [], preferredStrategyId: null,
  };

  const judgment = await createJevRecoveryAdapter(client)(snapshot);

  assert.deepEqual(Object.keys(observedBody!.questions.decision.criteria), ["escalate", "strategy_1"]);
  assert.match(observedBody!.questions.decision.criteria.strategy_1, /strategy:recovery/);
  assert.doesNotMatch(JSON.stringify(observedBody!.questions.decision.criteria), /strategy:baseline/);
  assert.deepEqual(judgment, {
    version: "orloom.judgment.v1", snapshotDigest: (await import("node:crypto")).createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    source: "jev", answer: "change_strategy", strategyId: "strategy:recovery", checkId: "check:recovery",
    policyVersion: "v1", policyDigest: "c".repeat(64), modelId, confidence: 0.75, usage: { inputTokens: 20, outputTokens: 3 },
  });
});
