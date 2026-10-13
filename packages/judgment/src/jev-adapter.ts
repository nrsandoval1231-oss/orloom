import type { EntryType } from "@typesafe-ai/sdk";
import type { RecoveryJudgmentAdapter, SchedulingJudgmentAdapter } from "../../governor/src/governor.js";
import { JevClient } from "./jev-client.js";
import type { JudgmentV1 } from "./types.js";
import { createHash } from "node:crypto";
import { deterministicRecovery } from "../../stuck-resolver/src/recovery.js";
import { canonicalJson } from "./canonical.js";
import type { SchedulingSnapshot } from "../../contracts/src/mission.js";

const snapshotDigest = (snapshot: unknown) => createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

/**
 * Creates a finite-action adapter. The caller must construct the client only
 * after operator credentials, exact model allowlisting, and spend policy are
 * available. This adapter has no command or plan mutation channel.
 */
export function createJevRecoveryAdapter(client: JevClient): RecoveryJudgmentAdapter {
  return async (snapshot) => {
    if (snapshot.status === "blocked" || snapshot.status === "unknown"
      || (snapshot.status === "failed" && snapshot.alternatives.length === 0)) {
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
    const orderedAlternatives = [...snapshot.alternatives].sort((a,b) => Number(b.id === snapshot.preferredStrategyId) - Number(a.id === snapshot.preferredStrategyId));
    orderedAlternatives.forEach((alternative, index) => {
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

/** Selects one opaque candidate identity from a bounded advisory scheduling snapshot. */
export function createJevSchedulingAdapter(client: JevClient): SchedulingJudgmentAdapter {
  return async snapshot => {
    const candidates=snapshot.choices.slice(0,32);
    if(candidates.length<2)throw new Error("scheduling advice needs at least two eligible choices");
    const choices:Record<string,string>={},labels=new Map<string,string>();
    candidates.forEach((candidate,index)=>{
      const label=`slice_${index+1}`;const identity=`${candidate.missionId}:${candidate.sliceId}`;
      labels.set(label,identity);
      const lesson=candidate.lessons.map(x=>({id:x.id,version:x.version,challengeDigest:x.challengeDigest,checkId:x.checkId,strategyId:x.strategyId,policyDigest:x.policyDigest}));
      choices[label]=`Approved candidate ${identity}; repository ${candidate.repository}; downstream depth ${candidate.downstreamDepth} slices; slice budget ${candidate.budgetCents} cents; mission budget ${candidate.missionBudgetCents} cents with ${candidate.reservedBudgetCents} reserved; scope risk ${candidate.scopeRisk}; matching promoted lesson provenance ${JSON.stringify(lesson)}`;
    });
    const state={version:"orloom.athena-scheduling-context.v1",capturedAt:snapshot.capturedAt,freeCapacity:snapshot.freeCapacity,choices:candidates.map(x=>({missionId:x.missionId,sliceId:x.sliceId,repository:x.repository,planDigest:x.planDigest,dependencies:x.dependencies,scopeRisk:x.scopeRisk,budgetCents:x.budgetCents,missionBudgetCents:x.missionBudgetCents,reservedBudgetCents:x.reservedBudgetCents,downstreamDepth:x.downstreamDepth,lessons:x.lessons}))};
    if(Buffer.byteLength(JSON.stringify(state),"utf8")>16_384)throw new Error("scheduling context exceeds local byte bound");
    const result=await client.choose({state:state as unknown as EntryType,choices});
    const selected=labels.get(result.choice);if(!selected)throw new Error("Jev selected an unknown scheduling option");return selected;
  };
}
