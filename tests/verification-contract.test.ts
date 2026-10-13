import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import { ArtifactReceiptV1, parseCheckCertificateV1, parseTrustedCheckReceiptV1, parseTrustedCheckRequestV1, parseTrustedVerifierCapabilityV1, receiptDigestV1, trustedCheckRequestDigestV1, TrustedCheckReceiptV1, TrustedCheckRequestV1 } from "../packages/contracts/src/verification.js";

const h = "a".repeat(64), commit = "b".repeat(40);
const request: TrustedCheckRequestV1 = {
  version: "orloom.trusted-check-request.v1", attemptId: "00000000-0000-4000-8000-000000000001",
  missionId: "00000000-0000-4000-8000-000000000002", sliceId: "build_worker-1",
  leaseEpoch: 2, repository: "acme/orloom", candidateSha: commit, expectedLocalHeadSha: commit,
  planDigest: h, checkId: "node-syntax", policyVersion: "v1", policyDigest: h,
  verifierImageDigest: h, inputBundleDigest: h, requestedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T12:05:00.000Z",
};
const empty: ArtifactReceiptV1 = { key: `sha256/${createHash("sha256").update("").digest("hex")}`, sha256: createHash("sha256").update("").digest("hex"), bytes: 0 };
function receipt(): TrustedCheckReceiptV1 {
  const body = {
    version: "orloom.trusted-check-receipt.v1" as const, request,
    verifierId: "verifier-local-1", runtime: "runsc" as const, sandboxId: "sandbox-1",
    outcome: "pass" as const, exitCode: 0, startedAt: "2026-10-13T12:00:01.000Z", finishedAt: "2026-10-13T12:00:02.000Z",
    stdout: empty, stderr: empty, inputManifest: empty,
  };
  return { ...body, receiptDigest: receiptDigestV1(body) };
}

test("parsers accept the exact typed request, receipt, capability metadata, and certificate", () => {
  assert.deepEqual(parseTrustedCheckRequestV1(request), request);
  assert.deepEqual(parseTrustedCheckReceiptV1(receipt()), receipt());
  assert.deepEqual(parseTrustedVerifierCapabilityV1({ attemptId: request.attemptId, verifierId: "verifier-local-1", expiresAt: request.expiresAt }), { attemptId: request.attemptId, verifierId: "verifier-local-1", expiresAt: request.expiresAt });
  const cert = { version: "orloom.check-certificate.v1", certificateId: request.attemptId, attemptId: request.attemptId, missionId: request.missionId, sliceId: request.sliceId, leaseEpoch: 2, repository: request.repository, candidateSha: commit, localHeadSha: commit, checkId: request.checkId, planDigest: h, policyVersion: "v1", policyDigest: h, receiptDigest: h, certifiedAt: request.requestedAt, scope: "local-exact-commit" };
  assert.deepEqual(parseCheckCertificateV1(cert), cert);
});

test("rejects unknown top-level and nested fields and malformed values", () => {
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, surprise: true }), /unknown fields/);
  assert.throws(() => parseTrustedCheckReceiptV1({ ...receipt(), request: { ...request, secret: "x" } }), /unknown fields/);
  assert.throws(() => parseTrustedCheckReceiptV1({ ...receipt(), stdout: { ...empty, url: "https://example.test" } }), /unknown fields/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, policyDigest: "A".repeat(64) }), /lowercase SHA-256/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, requestedAt: "2026-10-13T12:00:00-00:00" }), /UTC ISO-8601/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, expiresAt: "2026-10-13T12:20:00.000Z" }), /expiry window/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, sliceId: "bad/slice" }), /slice ID format/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, sliceId: "x".repeat(65) }), /sliceId is invalid/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, repository: "Acme/orloom" }), /canonical lowercase/);
  assert.throws(() => parseTrustedCheckRequestV1({ ...request, leaseEpoch: 0 }), /leaseEpoch is invalid/);
  assert.throws(() => parseTrustedCheckReceiptV1({ ...receipt(), finishedAt: "2026-10-13T12:00:02.001Z" }), /digest mismatch/);
});

test("receipt outcome, exit code, time range, and nested artifact bounds must agree", () => {
  const base = receipt();
  for (const changes of [
    { outcome: "pass", exitCode: 1 }, { outcome: "fail", exitCode: 0 }, { outcome: "fail", exitCode: -1 }, { outcome: "unknown", exitCode: 1 },
  ]) {
    const altered = { ...base, ...changes } as Omit<TrustedCheckReceiptV1, "receiptDigest">;
    assert.throws(() => parseTrustedCheckReceiptV1({ ...altered, receiptDigest: receiptDigestV1(altered as TrustedCheckReceiptV1) }), /outcome and exit code/);
  }
  const coercedOutcome = { ...base, outcome: ["pass"] };
  assert.throws(() => parseTrustedCheckReceiptV1({ ...coercedOutcome, receiptDigest: receiptDigestV1(coercedOutcome as unknown as TrustedCheckReceiptV1) }), /outcome is invalid/);
  const badArtifact = { ...base, stdout: { ...empty, bytes: 65_537 } };
  assert.throws(() => parseTrustedCheckReceiptV1({ ...badArtifact, receiptDigest: receiptDigestV1(badArtifact) }), /bytes is invalid/);
  const late = { ...base, startedAt: "2026-10-13T12:05:01.000Z" };
  assert.throws(() => parseTrustedCheckReceiptV1({ ...late, receiptDigest: receiptDigestV1(late) }), /time range/);
});

test("late UNKNOWN timeout evidence is retained while late PASS and FAIL are rejected", () => {
  const base = receipt();
  const lateUnknown = { ...base, outcome: "unknown", exitCode: null, startedAt: "2026-10-13T12:04:59.000Z", finishedAt: "2026-10-13T12:05:01.000Z" };
  const unknownReceipt = { ...lateUnknown, receiptDigest: receiptDigestV1(lateUnknown as unknown as TrustedCheckReceiptV1) };
  assert.deepEqual(parseTrustedCheckReceiptV1(unknownReceipt), unknownReceipt);
  for (const outcome of ["pass", "fail"] as const) {
    const lateTerminal = { ...base, outcome, exitCode: outcome === "pass" ? 0 : 1, startedAt: lateUnknown.startedAt, finishedAt: lateUnknown.finishedAt };
    assert.throws(() => parseTrustedCheckReceiptV1({ ...lateTerminal, receiptDigest: receiptDigestV1(lateTerminal as unknown as TrustedCheckReceiptV1) }), /time range/);
  }
});

test("canonical receipt digest ignores object key insertion order and metadata serializes no capability secret", () => {
  const first = receipt();
  const reordered = JSON.parse(canonicalJson(first)) as TrustedCheckReceiptV1;
  assert.equal(receiptDigestV1(first), receiptDigestV1(reordered));
  assert.equal(parseTrustedCheckReceiptV1(first).receiptDigest, receiptDigestV1(first));
  assert.equal(trustedCheckRequestDigestV1(request), trustedCheckRequestDigestV1(JSON.parse(canonicalJson(request)) as TrustedCheckRequestV1));
  const metadata = { attemptId: request.attemptId, verifierId: "verifier-local-1", expiresAt: request.expiresAt };
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
  assert.equal(JSON.stringify(first).includes("capability"), false);
});
