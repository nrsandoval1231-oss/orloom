import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { MissionGovernor } from "../packages/governor/src/governor.js";
import { CertifiedLearningActivation } from "../packages/learning/src/activation.js";
import type { CheckCertificateV1 } from "../packages/contracts/src/verification.js";

test("promotion fails closed before lesson lookup when runtime acceptance is absent", async () => {
  const governor = new MissionGovernor(new MemoryMissionStore(), { maxLanes: 6, capacitySlots: 0, leaseSeconds: 300, trustedCheckPolicyDigest: null });
  await assert.rejects(governor.promoteLesson("missing", "a".repeat(64)), /Learning runtime acceptance is unavailable/);
});

test("activation requires the current exact-runtime full-suite certificate on every call", async () => {
  const binding = { missionId: "mission", sliceId: "slice", runtimeSha: "a".repeat(40), certificateId: "certificate", policyDigest: "b".repeat(64) };
  const certificate: CheckCertificateV1 = { version: "orloom.check-certificate.v1", ...binding,
    candidateSha: binding.runtimeSha, localHeadSha: binding.runtimeSha, checkId: "node-repo-suite-v1",
    attemptId: "attempt", leaseEpoch: 1, repository: "owner/repo", planDigest: "c".repeat(64),
    policyVersion: "v1", receiptDigest: "d".repeat(64), certifiedAt: new Date().toISOString(), scope: "local-exact-commit" };
  let current: CheckCertificateV1 | null = certificate;
  const authority = new CertifiedLearningActivation({ getCertificate: async () => current }, binding);
  await authority.assertAccepted();
  for (const mutation of [{ checkId: "node-syntax-v1" }, { candidateSha: "e".repeat(40) },
    { localHeadSha: "e".repeat(40) }, { certificateId: "other" }, { policyDigest: "f".repeat(64) },
    { missionId: "other" }, { sliceId: "other" }]) {
    current = { ...certificate, ...mutation };
    await assert.rejects(authority.assertAccepted(), /acceptance is unavailable/);
  }
  current = null;
  await assert.rejects(authority.assertAccepted(), /acceptance is unavailable/);
});
