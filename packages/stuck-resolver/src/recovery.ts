import type { DecisionSnapshotV1, JudgmentV1 } from "../../judgment/src/types.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { createHash } from "node:crypto";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Deterministic fallback only selects a policy entry already present in the snapshot. */
export function deterministicRecovery(snapshot: DecisionSnapshotV1): JudgmentV1 {
  const preferred = snapshot.preferredStrategyId
    ? snapshot.alternatives.find(x => x.id === snapshot.preferredStrategyId && !snapshot.triedStrategies.includes(x.id))
    : undefined;
  const next = preferred ?? snapshot.alternatives.find(x => x.id !== snapshot.strategyId && !snapshot.triedStrategies.includes(x.id));
  const answer = snapshot.status === "failed" ? (next ? "change_strategy" : "escalate") :
    snapshot.status === "passed" || snapshot.status === "started" ? "continue" : "escalate";
  return {
    version: "orloom.judgment.v1", snapshotDigest: digest(snapshot), source: "deterministic", answer,
    strategyId: answer === "change_strategy" ? next!.id : null,
    checkId: answer === "change_strategy" ? next!.policy.checkId : null,
    policyVersion: (answer === "change_strategy" ? next!.policy : snapshot.alternatives[0]?.policy)?.version ?? "none",
    policyDigest: snapshot.recoveryPolicyDigest, modelId: null, confidence: null, usage: null
  };
}
