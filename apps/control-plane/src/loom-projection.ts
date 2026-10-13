import type { Mission, MissionEvent, MissionPlan, MissionSlice } from "../../../packages/contracts/src/mission.js";

export interface LoomEventRow { cursor: number; time: string; type: string; label: string; sliceId: string | null; checkId: string | null; references: Array<{ kind: "candidate" | "certificate" | "integration" | "recovery" | "lesson" | "decision"; id: string; digest?: string }>; }
export interface LoomProjection {
  mission: { id: string; repository: string; objective: string; status: string } | null;
  slices: Array<{ id: string; objective: string; owner: string; dependencies: string[]; status: string; checks: string[]; candidateSha: string | null; leaseEpoch: number }>;
  events: LoomEventRow[];
  lastCursor: number;
  state: "available" | "UNKNOWN";
  closed: boolean;
  notice: string;
}

const labels: Record<string, string> = {
  "mission.submitted": "Mission created", "plan.recommended": "Plan recommended", "plan.approved": "Plan approved",
  "slice.claimed": "Slice claimed", "slice.running": "Slice started", "slice.awaiting_verification": "Awaiting verification",
  "slice.blocked": "Slice blocked", "slice.unknown": "Slice state unknown", "slice.lease_expired_unknown": "Lease expired · state unknown",
  "slice.judgment_unknown": "Judgment unavailable", "slice.integrated": "Slice integrated", "slice.integration_pending": "Integration pending",
  "slice.integration_unknown": "Integration unknown", "check.attempted": "Check started", "check.certified": "Check certified",
  "check.failed": "Check failed", "check.unknown": "Check unavailable", "check.recovery_attempted": "Recovery check started",
  "check.recovery_pass": "Recovery check passed", "check.recovery_fail": "Recovery check failed", "check.recovery_unknown": "Recovery check unknown",
  "slice.progress": "Governor decision recorded", "slice.candidate": "Candidate recorded", "slice.failed": "Slice failed",
  "scheduling.decision": "Scheduling decision recorded", "sol.replan_requested": "Replan requested",
  "lesson.candidate": "Lesson candidate recorded", "lesson.promoted": "Lesson promoted", "lesson.withdrawn": "Lesson withdrawn"
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

export function projectLoom(mission: Mission | null, plan: MissionPlan | null, slices: MissionSlice[] | null, events: MissionEvent[] | null, availability: { connected?: boolean; stale?: boolean } = {}): LoomProjection {
  const safeMission = mission ? { id: mission.id, repository: mission.repository, objective: mission.objective, status: mission.status } : null;
  const safeSlices = (Array.isArray(slices) ? slices : []).map(s => ({ id: s.id, objective: s.objective, owner: s.owner, dependencies: [...s.dependencies], status: s.status, checks: [...s.checks], candidateSha: s.candidateSha, leaseEpoch:s.leaseEpoch }));
  const rows: LoomEventRow[] = [];
  let lastCursor = 0, malformed = !mission || !Array.isArray(slices) || !Array.isArray(events) || !events?.length;
  const planned = Array.isArray(plan?.slices) ? plan!.slices : [], planIds = planned.map(s => s.id), sliceIds = safeSlices.map(s => s.id);
  const planValid = Boolean(plan && plan.missionId === mission?.id && planIds.length > 0 && new Set(planIds).size === planIds.length && new Set(sliceIds).size === sliceIds.length && planIds.length === sliceIds.length && planIds.every(id => sliceIds.includes(id)) && planned.every(p => { const current = slices?.find(x => x.id === p.id); return current && current.objective === p.objective && current.owner === p.owner && JSON.stringify(current.dependencies) === JSON.stringify(p.dependencies) && JSON.stringify(current.checks) === JSON.stringify(p.checks) && JSON.stringify(current.scopes) === JSON.stringify(p.scopes) && current.budgetCents === p.budgetCents; }));
  if (!planValid) malformed = true;
  const certs = new Map<string, Map<string, { id: string; digest: string | null; candidate: string | null; epoch: number | null; cursor: number }>>(), pending = new Map<string, { cursor: number; ids: string[]; digests: string[]; candidate: string | null; epoch: number | null; treeSha: string | null; reviewDigest: string | null; expectedSha: string | null }>(), integrated = new Map<string, { candidate: string | null; cursor: number; epoch: number | null; treeSha: string | null; reviewDigest: string | null }>();
  if (Array.isArray(events)) for (const event of events) {
    if (!Number.isSafeInteger(event.cursor) || event.cursor <= lastCursor || event.missionId !== mission?.id) { malformed = true; continue; }
    lastCursor = event.cursor;
    const d = record(event.data), sid = str(d.sliceId), refs: LoomEventRow["references"] = [];
    const candidate = str(d.candidateSha); if (candidate) refs.push({ kind: "candidate", id: candidate });
    const attempt = str(d.attemptId); if (attempt && event.type.startsWith("check.recovery_")) refs.push({ kind:"recovery", id:attempt });
    const lesson = str(d.lessonId); if (lesson && event.type.startsWith("lesson.")) refs.push({ kind:"lesson", id:lesson });
    const decision = str(d.decisionId); if (decision && event.type === "scheduling.decision") refs.push({ kind:"decision", id:decision });
    const strategy = str(d.strategyId); if (strategy && (event.type.startsWith("check.recovery_") || event.type === "slice.progress" || event.type.startsWith("lesson."))) refs.push({ kind:"recovery", id:strategy });
    const check = str(d.checkId) ?? str(d.targetCheckId); if (check && (event.type.startsWith("check.") || event.type === "slice.progress")) refs.push({ kind:"recovery", id:check });
    const challengeDigest = str(d.challengeDigest); if (challengeDigest && event.type.startsWith("lesson.")) refs.push({ kind:"lesson", id:challengeDigest, digest:challengeDigest });
    if (event.type === "check.certified") {
      const id = str(d.certificateId), check = str(d.checkId), digest = str(d.certificateDigest); if (sid && id && check) { const set = certs.get(sid) ?? new Map<string,{id:string;digest:string|null;candidate:string|null;epoch:number|null;cursor:number}>(); set.set(check,{id,digest,candidate,epoch:Number.isSafeInteger(d.leaseEpoch)?Number(d.leaseEpoch):null,cursor:event.cursor}); certs.set(sid,set); refs.push({ kind: "certificate", id, ...(digest ? { digest } : {}) }); }
    }
    if (event.type === "slice.integration_pending" && sid) {
      const ids = Array.isArray(d.certificateIds) ? d.certificateIds.filter((x): x is string => typeof x === "string") : [];
      const digests = Array.isArray(d.certificateDigests) ? d.certificateDigests.filter((x): x is string => typeof x === "string") : [];
      pending.set(sid, { cursor:event.cursor, ids, digests, candidate, epoch:Number.isSafeInteger(d.leaseEpoch)?Number(d.leaseEpoch):null, treeSha:str(d.treeSha), reviewDigest:str(d.reviewArtifactDigest), expectedSha:str(d.expectedIntegrationSha) });
      ids.forEach((id, index) => refs.push({ kind: "certificate", id, ...(digests[index] ? { digest: digests[index] } : {}) }));
      if (str(d.treeSha)) refs.push({ kind: "integration", id: str(d.treeSha)! });
      if (str(d.reviewArtifactDigest)) refs.push({ kind: "integration", id: str(d.reviewArtifactDigest)!, digest: str(d.reviewArtifactDigest)! });
    }
    if (event.type === "slice.integrated" && sid) { integrated.set(sid, { candidate, cursor: event.cursor, epoch:Number.isSafeInteger(d.leaseEpoch)?Number(d.leaseEpoch):null, treeSha:str(d.treeSha), reviewDigest:str(d.reviewArtifactDigest) }); const id = str(d.expectedIntegrationSha) ?? str(d.treeSha); if (id) refs.push({ kind: "integration", id }); if(str(d.reviewArtifactDigest))refs.push({kind:"integration",id:str(d.reviewArtifactDigest)!,digest:str(d.reviewArtifactDigest)!}); }
    const label = labels[event.type] ?? "Mission event";
    rows.push({ cursor: event.cursor, time: event.createdAt, type: event.type, label, sliceId: sid, checkId:str(d.checkId), references: refs });
  }
  const allVerified = safeSlices.length > 0 && safeSlices.every(s => {
    const done = integrated.get(s.id), invalidated = done && rows.some(row => row.sliceId === s.id && row.cursor > Math.min(...[...(certs.get(s.id)?.values() ?? [])].map(c => c.cursor), pending.get(s.id)?.cursor ?? Infinity) && ["check.unknown","check.failed","check.recovery_fail","check.recovery_unknown","slice.integration_unknown","slice.lease_expired_unknown","slice.unknown","slice.blocked","slice.failed"].includes(row.type));
    const proof = pending.get(s.id), certified = certs.get(s.id);
    const certifiedForChecks = s.checks.map(check => certified?.get(check));
    return plan?.approvedAt !== null && plan?.approvedAt !== undefined && planValid && s.status === "verified" && s.checks.length > 0 && /^[a-f0-9]{40}$/i.test(s.candidateSha ?? "") && certifiedForChecks.every(cert => cert && cert.candidate === s.candidateSha && cert.epoch === s.leaseEpoch && cert.cursor < (proof?.cursor ?? Infinity)) && proof && proof.ids.length === proof.digests.length && proof.ids.length === s.checks.length && new Set(proof.ids).size === proof.ids.length && proof.digests.every(digest => /^[a-f0-9]{64}$/i.test(digest)) && certifiedForChecks.every(cert => cert && proof.ids.includes(cert.id)) && done && proof.cursor < done.cursor && !invalidated && proof.candidate === s.candidateSha && done.candidate === s.candidateSha && proof.epoch === s.leaseEpoch && done.epoch === s.leaseEpoch && /^[a-f0-9]{40}$/i.test(proof.treeSha ?? "") && /^[a-f0-9]{40}$/i.test(proof.expectedSha ?? "") && /^[a-f0-9]{64}$/i.test(proof.reviewDigest ?? "") && proof.treeSha === done.treeSha && proof.reviewDigest === done.reviewDigest;
  });
  const ids = new Set(safeSlices.map(s => s.id));
  const dependenciesValid = safeSlices.every(s => s.dependencies.every(dep => ids.has(dep)));
  const connected = availability.connected !== false && !availability.stale;
  const durableUnknown = mission?.status === "unknown" || safeSlices.some(s => s.status === "unknown");
  const unknown = malformed || !connected || !dependenciesValid || durableUnknown;
  return { mission: safeMission, slices: safeSlices, events: rows, lastCursor, state: unknown ? "UNKNOWN" : "available", closed: !unknown && mission?.status === "verified" && allVerified,
    notice: unknown ? (availability.stale ? "Showing history · live state is stale or unavailable." : availability.connected === false ? "Disconnected · showing last observed history." : durableUnknown ? "A planned slice has durable UNKNOWN state." : "Evidence is incomplete or inconsistent · closure unavailable.") : allVerified ? "Every planned slice has durable certification and integration evidence." : "Open · waiting for durable certification and integration evidence." };
}
