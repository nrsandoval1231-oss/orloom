import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateDeliveryEvidenceReferences } from "../packages/integration/src/delivery.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const integration = `integration:${"a".repeat(40)}`;
const review = `review:${"b".repeat(64)}`;

test("delivery accepts only fixed worker evidence labels after digest readback", async () => {
  const bytes = Buffer.from("retained worker bundle fixture"), digest = hash(bytes), key = `sha256/${digest}`;
  const store = { async get(requested: string) { assert.equal(requested, key); return bytes; } } as never;
  const references = [`candidate-bundle:${key}`, key, integration, review];
  await validateDeliveryEvidenceReferences(references, integration, review, store);
  assert.equal(references[0], `candidate-bundle:${key}`, "the label remains intact for candidate admission");
});

test("delivery rejects unknown evidence labels before treating them as artifact refs", async () => {
  let reads = 0;
  const store = { async get() { reads++; return Buffer.from("bytes"); } } as never;
  await assert.rejects(validateDeliveryEvidenceReferences([`arbitrary:${`sha256/${"c".repeat(64)}`}`, integration, review], integration, review, store), /evidence/);
  assert.equal(reads, 0);
});

test("delivery rejects named worker evidence with a mismatched artifact digest", async () => {
  const claimedDigest = "d".repeat(64), store = { async get() { return Buffer.from("different bytes"); } } as never;
  await assert.rejects(validateDeliveryEvidenceReferences([`provider-usage:sha256/${claimedDigest}`, integration, review], integration, review, store), /digest/);
});

test("delivery rejects two different artifacts under the same worker evidence label", async () => {
  const firstBytes = Buffer.from("bundle one"), secondBytes = Buffer.from("bundle two");
  const firstDigest = hash(firstBytes), secondDigest = hash(secondBytes);
  const artifacts = new Map([[`sha256/${firstDigest}`, firstBytes], [`sha256/${secondDigest}`, secondBytes]]);
  const store = { async get(key: string) { const bytes = artifacts.get(key); assert.ok(bytes); return bytes; } } as never;
  await assert.rejects(validateDeliveryEvidenceReferences([
    `candidate-bundle:sha256/${firstDigest}`,
    `candidate-bundle:sha256/${secondDigest}`,
    integration,
    review
  ], integration, review, store), /duplicate named worker evidence/);
});
