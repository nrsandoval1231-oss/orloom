import { createHash } from "node:crypto";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { parseTrustedCheckReceiptV1, trustedCheckRequestDigestV1, type TrustedCheckRequestV1 } from "../../contracts/src/verification.js";
import { eligibleLessonPair, lessonChallengeDigest, type LessonEpisodeObservation, type LessonProvenance } from "./lesson-policy.js";

export interface ChallengedAttempt {
  attemptId: string; eventId: string; observation: LessonEpisodeObservation;
  outcome: "pass" | "fail" | "unknown"; candidateSha: string; checkId: string;
  requestDigest: string; receiptDigest: string; artifacts: Array<{ sha256: string; bytes: number }>;
  request:TrustedCheckRequestV1; receipt: unknown; stdout: Uint8Array; stderr: Uint8Array; manifest: Uint8Array;
}
export interface ChallengeResult {
  decision: "accepted" | "rejected"; reason: string; verifierId: string; algorithmVersion: "orloom.lesson-challenger.v1";
  challengeDigest: string; evidenceDigest: string; provenance: LessonProvenance;
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** Produces a durable negative attestation when trusted receipt/artifact readback itself fails. */
export function rejectTrustedLessonReadback(input: { verifierId: string; provenance: LessonProvenance; evidence: unknown; reason: string }): ChallengeResult {
  return { decision: "rejected", reason: input.reason, verifierId: input.verifierId, algorithmVersion: "orloom.lesson-challenger.v1",
    challengeDigest: lessonChallengeDigest(input.provenance), evidenceDigest: hash(canonicalJson(input.evidence)), provenance: input.provenance };
}

/** Recomputes a two-episode observation from persisted attempts and artifact bytes. */
export function challengeTrustedLesson(input: {
  verifierId: string; provenance: LessonProvenance; attempts: ChallengedAttempt[];
  expectedPolicyDigest: string; expectedTrustedRunnerPolicyDigest:string; expectedCheckIds: ReadonlySet<string>;
}): ChallengeResult {
  const reject = (reason: string): ChallengeResult => ({
    decision: "rejected", reason, verifierId: input.verifierId, algorithmVersion: "orloom.lesson-challenger.v1",
    challengeDigest: lessonChallengeDigest(input.provenance),
    evidenceDigest: hash(canonicalJson(input.attempts.map(a => ({ attemptId:a.attemptId, receiptDigest:a.receiptDigest, requestDigest:a.requestDigest, artifacts:a.artifacts })))),
    provenance: input.provenance,
  });
  const attempts = input.attempts;
  if (!input.verifierId || attempts.length !== 4 || new Set(attempts.map(a => a.attemptId)).size !== 4
      || new Set(attempts.map(a => a.eventId)).size !== 4) return reject("four distinct trusted attempts and events are required");
  if (attempts.some(a => a.outcome === "unknown" || !input.expectedCheckIds.has(a.checkId)
      || a.observation.decisionStatus !== "committed" || a.observation.trustedCheckPolicyDigest !== input.expectedPolicyDigest
      || a.observation.recoveryPolicyDigest!==input.provenance.policyDigest
      || a.observation.eventId !== a.eventId || a.observation.status !== (a.outcome === "pass" ? "passed" : "failed")
      || !/^[a-f0-9]{40}$/.test(a.candidateSha) || !/^[a-f0-9]{64}$/.test(a.requestDigest)
      || !/^[a-f0-9]{64}$/.test(a.receiptDigest)
      || a.artifacts.length !== 3 || a.artifacts.some(x => !/^[a-f0-9]{64}$/.test(x.sha256) || !Number.isSafeInteger(x.bytes) || x.bytes < 0)
      || hash(a.manifest) !== a.artifacts[2]?.sha256 || a.manifest.byteLength !== a.artifacts[2]?.bytes)) return reject("attempt outcome, policy, candidate, or persisted manifest binding is invalid");
  try {
    for (const attempt of attempts) {
      const receipt = parseTrustedCheckReceiptV1(attempt.receipt);
      if (receipt.receiptDigest !== attempt.receiptDigest || receipt.request.checkId !== attempt.checkId
          || receipt.request.candidateSha !== attempt.candidateSha || receipt.outcome !== attempt.outcome
          || trustedCheckRequestDigestV1(receipt.request) !== attempt.requestDigest
          || canonicalJson(receipt.request)!==canonicalJson(attempt.request)
          || receipt.request.policyDigest!==input.expectedTrustedRunnerPolicyDigest
          || receipt.request.missionId!==attempt.observation.missionId||receipt.request.sliceId!==attempt.observation.sliceId
          || receipt.request.leaseEpoch!==attempt.observation.leaseEpoch||receipt.request.repository!==attempt.observation.repository
          || receipt.request.expectedLocalHeadSha!==attempt.candidateSha
          || hash(attempt.manifest) !== receipt.inputManifest.sha256
          || attempt.manifest.byteLength !== receipt.inputManifest.bytes
          || hash(attempt.stdout)!==receipt.stdout.sha256||attempt.stdout.byteLength!==receipt.stdout.bytes
          || hash(attempt.stderr)!==receipt.stderr.sha256||attempt.stderr.byteLength!==receipt.stderr.bytes
          || canonicalJson(attempt.artifacts.map(a=>({sha256:a.sha256,bytes:a.bytes})).sort((a,b)=>a.sha256.localeCompare(b.sha256)))
            !== canonicalJson([receipt.stdout,receipt.stderr,receipt.inputManifest].map(a=>({sha256:a.sha256,bytes:a.bytes})).sort((a,b)=>a.sha256.localeCompare(b.sha256)))) return reject("receipt, request, candidate, outcome, or artifact manifest digest disagrees");
    }
  } catch { return reject("persisted trusted receipt is invalid"); }
  const byEvent = new Map(attempts.map(a => [a.eventId, a]));
  const ids = [...input.provenance.evidenceEventIds].sort();
  if (ids.length !== 4 || new Set(ids).size !== 4 || ids.some(id => !byEvent.has(id))) return reject("candidate events do not resolve to the four verified attempts");
  const episodes = new Map<string, ChallengedAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.observation.missionId}:${attempt.observation.sliceId}`;
    episodes.set(key, [...(episodes.get(key) ?? []), attempt]);
  }
  if (episodes.size !== 2 || [...episodes.values()].some(pair => pair.length !== 2)) return reject("evidence must contain two distinct comparable episodes");
  const pairs = [...episodes.values()].map(pair => pair.sort((a,b) => a.observation.ordinal-b.observation.ordinal));
  if (pairs.some(([failure, success]) => !failure || !success || failure.outcome !== "fail" || success.outcome !== "pass"
      || !eligibleLessonPair(failure.observation, success.observation)
      || success.observation.strategyId !== input.provenance.strategyId
      || failure.observation.targetCheckId !== input.provenance.fromCheckId
      || success.observation.targetCheckId !== input.provenance.fromCheckId)) return reject("episode transition does not match the proposed scoped failed-to-passed observation");
  const computed = { ...input.provenance, evidenceEventIds: ids, baseline: { failed:2, observed:2 }, outcome: { passed:2, observed:2 }, metric:"trusted_check_pass_rate" as const, direction:"increase" as const };
  if (canonicalJson(computed) !== canonicalJson(input.provenance)) return reject("candidate metric or provenance differs from recomputed observations");
  const evidenceDigest = hash(canonicalJson(attempts.map(a => ({ attemptId:a.attemptId, eventId:a.eventId, candidateSha:a.candidateSha, requestDigest:a.requestDigest, receiptDigest:a.receiptDigest, artifacts:a.artifacts })).sort((a,b)=>a.eventId.localeCompare(b.eventId))));
  return { decision:"accepted", reason:"two comparable trusted fail-to-pass episodes were independently recomputed", verifierId:input.verifierId,
    algorithmVersion:"orloom.lesson-challenger.v1", challengeDigest:lessonChallengeDigest(computed), evidenceDigest, provenance:computed };
}
