import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { cancellationSummary, certificateLinkAvailable, loomDocument, readinessSummary } from "../apps/control-plane/src/loom-page.js";

test("readiness is bounded to configuration evidence and becomes unavailable for stale views", () => {
  const readiness = { state: "ready", meaning: "control-plane prerequisites only; no live worker/runtime/provider/image attestation", reasons: [], configuration: { mode: "approved", workerPolicyConfigured: true, verificationConfigured: true, integrationConfigured: true, deliveryConfigured: true, capacityEvidenceDigest: "sha256:abc", capacityEvidenceExpiresAt: "2030-01-01T00:00:00Z", baseSha: "b".repeat(40), planDigest: "sha256:def", checkPolicyDigest: "sha256:ghi" } };
  assert.deepEqual(readinessSummary(readiness, true), { label: "Prerequisites ready", details: [readiness.meaning, "Live execution: unverified", "Mode: approved", "Worker policy: configured", "Verification: configured", "Integration: configured", "Delivery: configured", "Capacity evidence: sha256:abc", "Capacity evidence expires: 2030-01-01T00:00:00Z", "Base: " + "b".repeat(40), "Plan: sha256:def", "Check policy: sha256:ghi"] });
  assert.equal(readinessSummary(readiness, false).label, "Readiness unavailable");
  assert.equal(readinessSummary({ ...readiness, state: "unverified" }, true).label, "Prerequisites unverified");
  assert.equal(readinessSummary({ ...readiness, state: "unavailable" }, true).label, "Readiness unavailable");
});

test("cancellation summary reports durable states by exact lease epoch", () => {
  const cancellation = { state: "quarantined-unknown", reasons: ["reconciliation pending"], slices: [{ sliceId: "slice-a", leaseEpoch: 7, state: "runtime-absence-settled", reasons: ["runtime absence recorded"] }, { sliceId: "slice-b", leaseEpoch: 8, state: "quarantined-unknown", reasons: ["runtime outcome unknown"] }] };
  assert.deepEqual(cancellationSummary(cancellation), ["Mission: quarantined-unknown", "reconciliation pending", "slice-a · epoch 7: runtime-absence-settled · runtime absence recorded", "slice-b · epoch 8: quarantined-unknown · runtime outcome unknown"]);
  assert.deepEqual(cancellationSummary({ state: "none", reasons: [], slices: [] }), ["Mission: none"]);
});

test("certificate links exist only while the matching current slice is awaiting verification", () => {
  const event = { sliceId: "s-1", checkId: "check:unit", references: [{ kind: "candidate", id: "a".repeat(40) }] };
  const awaiting = { id: "s-1", status: "awaiting_verification", candidateSha: "a".repeat(40), checks: ["check:unit"] };
  assert.equal(certificateLinkAvailable(awaiting, event), true);
  assert.equal(certificateLinkAvailable({ ...awaiting, status: "verified" }, event), false);
  assert.equal(certificateLinkAvailable({ ...awaiting, candidateSha: "b".repeat(40) }, event), false);
  assert.equal(certificateLinkAvailable({ ...awaiting, checks: ["other"] }, event), false);
  assert.equal(certificateLinkAvailable(undefined, event), false);
});

test("Loom renders its tested certificate rule and keeps explicit fallback and bounded polling controls", () => {
  const html = loomDocument("nonce-value");
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert(source);
  assert.doesNotThrow(() => new Script(source));
  assert.match(source, /fallback\.removeAttribute\('hidden'\)/);
  assert.match(source, /fallback\.setAttribute\('hidden',''\)/);
  assert.match(source, /details\.open=true/);
  assert.match(source, /e\.key==='Enter'\|\|e\.key===' '/);
  assert.match(source, /pollTimer=setTimeout/);
  assert.match(source, /clearTimeout\(pollTimer\)/);
  assert.match(source, /certificateAvailable\(slice,e\)/);
  assert.match(source, /'Evidence connected'/);
  assert.match(source, /readinessSummary\(view\.readiness,isLive&&view\.state==='available'\)/);
  assert.match(source, /cancellationSummary\(view\.cancellation\)/);
  assert.match(html, /id="readiness-state"/);
  assert.match(html, /id="readiness-desktop-state"/);
  assert.match(html, /id="cancellation"/);
  assert.match(html, /id="cancellation-desktop"/);
  assert.match(html, /#inspect\{display:none\}/);
  assert.match(html, /\.desktop-summary\{display:none\}#inspect\{display:block\}/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML/);
});
