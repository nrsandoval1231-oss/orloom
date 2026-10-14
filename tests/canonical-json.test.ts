import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../packages/judgment/src/canonical.js";

test("canonical JSON makes key-order permutations hash-identical, including nested JSONB values", () => {
  const beforeRoundTrip = {
    eventId: "event-1",
    counters: { inputTokens: 11, providerCalls: 1 },
    evidenceRefs: ["sha256:" + "a".repeat(64)],
  };
  const afterJsonbRoundTrip = {
    evidenceRefs: ["sha256:" + "a".repeat(64)],
    counters: { providerCalls: 1, inputTokens: 11 },
    eventId: "event-1",
  };
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

  assert.equal(canonicalJson(beforeRoundTrip), canonicalJson(afterJsonbRoundTrip));
  assert.equal(hash(beforeRoundTrip), hash(afterJsonbRoundTrip));
});
