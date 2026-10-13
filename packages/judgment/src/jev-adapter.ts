import type { EntryType } from "@typesafe-ai/sdk";
import type { RecoveryJudgmentAdapter } from "../../governor/src/governor.js";
import { JevClient } from "./jev-client.js";
import type { JudgmentV1 } from "./types.js";
import { createHash } from "node:crypto";
import { deterministicRecovery } from "../../stuck-resolver/src/recovery.js";
import { canonicalJson } from "./canonical.js";

const snapshotDigest = (snapshot: unknown) => createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

/**
 * Creates a finite-action adapter. The caller must construct the client only
 * after operator credentials, exact model allowlisting, and spend policy are
 * available. This adapter has no command or plan mutation channel.
 */
export function createJevRecoveryAdapter(client: JevClient): RecoveryJudgmentAdapter {
  return async (snapshot) => {
    if (snapshot.status === "failed" && snapshot.alternatives.length === 0) {
      return deterministicRecovery(snapshot);
    }
    if (snapshot.alternatives.length > 29) return deterministicRecovery(snapshot);
    const choices: Record<string, string> = snapshot.status === "failed"
      ? { escalate: "Stop this recovery episode and retain its uncertainty." }
      : {
          continue: "Keep the currently approved strategy and report progress.",
          request_replan: "Ask the owner/controller to review the plan; do not change it.",
          escalate: "Stop this recovery episode and retain its uncertainty.",
        };
    const labels = new Map<string, typeof snapshot.alternatives[number]>();
    snapshot.alternatives.forEach((alternative, index) => {
      const label = `strategy_${index + 1}`;
      labels.set(label, alternative);
      choices[label] = `Use approved strategy ${alternative.id}, which maps to trusted check ${alternative.policy.checkId}; expected signal: ${alternative.policy.expectedSignal}`;
    });
    const result = await client.choose({ state: snapshot as unknown as EntryType, choices });
    const next = labels.get(result.choice);
    const isAction = Object.hasOwn(choices, result.choice);
    if (!isAction) throw new Error("Jev selected an unrecognized recovery action");
    const answer: JudgmentV1["answer"] = next ? "change_strategy" : result.choice as JudgmentV1["answer"];
    if (!["continue", "request_replan", "escalate", "change_strategy"].includes(answer)) {
      throw new Error("Jev selected an unrecognized recovery action");
    }
    return {
      version: "orloom.judgment.v1",
      snapshotDigest: snapshotDigest(snapshot),
      source: "jev",
      answer,
      strategyId: next?.id ?? null,
      checkId: next?.policy.checkId ?? null,
      policyVersion: next?.policy.version ?? snapshot.alternatives[0]?.policy.version ?? "none",
      policyDigest: snapshot.recoveryPolicyDigest,
      modelId: result.model,
      confidence: result.confidence,
      usage: result.usage,
    };
  };
}
