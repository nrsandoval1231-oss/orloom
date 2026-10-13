import { test } from "node:test";
import assert from "node:assert/strict";
import { projectLoom } from "../apps/control-plane/src/loom-projection.js";
import type { Mission, MissionEvent, MissionPlan, MissionSlice } from "../packages/contracts/src/mission.js";

const mission = (status: Mission["status"] = "ready"): Mission => ({ id: "m-1", repository: "owner/repo", baseSha: "a".repeat(40), objective: "Ship the actual work", acceptance: ["check"], budgetCents: 10, status, reservedCents: 0, createdAt: "2026-01-01T00:00:00Z" });
const slice = (status: MissionSlice["status"] = "ready"): MissionSlice => ({ missionId: "m-1", id: "s-1", objective: "Build it", dependencies: [], owner: "core", scopes: ["src/**"], checks: ["check:unit"], budgetCents: 10, status, leaseEpoch: 1, leaseToken: null, leaseExpiresAt: null, candidateSha: "b".repeat(40), evidenceRefs: [] });
const plan = (approvedAt: string | null = "2026-01-01T00:00:00Z"): MissionPlan => ({ missionId:"m-1", slices:[{id:"s-1",objective:"Build it",dependencies:[],owner:"core",scopes:["src/**"],checks:["check:unit"],budgetCents:10}],recommendedBy:"owner",recommendedAt:"2026-01-01T00:00:00Z",approvedAt });
const ev = (cursor: number, type: string, data: Record<string, unknown> = {}): MissionEvent => ({ cursor, missionId: "m-1", type, data, createdAt: "2026-01-01T00:00:00Z" });
const completeEvents = () => [ev(2,"check.certified",{sliceId:"s-1",certificateId:"cert-1",certificateDigest:"c".repeat(64),checkId:"check:unit",leaseEpoch:1,candidateSha:"b".repeat(40)}),ev(8,"slice.integration_pending",{sliceId:"s-1",leaseEpoch:1,candidateSha:"b".repeat(40),treeSha:"d".repeat(40),expectedIntegrationSha:"e".repeat(40),reviewArtifactDigest:"f".repeat(64),certificateIds:["cert-1"],certificateDigests:["c".repeat(64)]}),ev(13,"slice.integrated",{sliceId:"s-1",leaseEpoch:1,candidateSha:"b".repeat(40),treeSha:"d".repeat(40),reviewArtifactDigest:"f".repeat(64)})];

test("Loom projection preserves ownership and dependencies without inventing progress", () => {
  const dependent={...slice(),dependencies:["s-0"]}, parent={...slice(),id:"s-0",objective:"Prepare it"};
  const view = projectLoom(mission(), plan(), [parent,dependent], [ev(1,"mission.submitted"), ev(5,"unknown.new_event", { text: "<script>alert(1)</script>" })]);
  assert.equal(view.closed, false); assert.equal(view.lastCursor, 5); assert.equal(view.slices[1]?.owner,"core"); assert.deepEqual(view.slices[1]?.dependencies,["s-0"]);
  assert.equal(view.events[1]?.label,"Mission event"); assert.equal(view.mission?.objective,"Ship the actual work");
});

test("durable verified, certified, and integrated evidence closes every planned slice", () => {
  const view = projectLoom(mission("verified"), plan(), [slice("verified")], completeEvents());
  assert.equal(view.closed,true); assert.equal(view.state,"available"); assert.match(view.notice,/durable certification/);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("awaiting_verification")],completeEvents()).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],[...completeEvents().slice(1)]).closed,false);
});

test("contradictions, unknown state, duplicate and out-of-order cursors fail closed", () => {
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],[...completeEvents(),ev(21,"check.unknown",{sliceId:"s-1"})]).closed,false);
  assert.equal(projectLoom(mission("unknown"),plan(),[slice("unknown")],completeEvents()).closed,false);
  for (const events of [[ev(4,"x"),ev(4,"x")],[ev(5,"x"),ev(3,"x")]]) {
    const view=projectLoom(mission("verified"),plan(),[slice("verified")],events); assert.equal(view.closed,false); assert.equal(view.state,"UNKNOWN");
  }
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],completeEvents(),{connected:false}).closed,false);
  assert.match(projectLoom(mission("verified"),plan(),[slice("verified")],completeEvents(),{connected:false}).notice,/Disconnected/);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],completeEvents(),{stale:true}).state,"UNKNOWN");
});

test("candidate, lease, certificate, tree and review bindings must remain exact", () => {
  const baseline=completeEvents();
  const mismatch=(index:number,data:Record<string,unknown>)=>baseline.map((e,i)=>i===index?{...e,data:{...e.data,...data}}:e);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],mismatch(0,{candidateSha:"a".repeat(40)})).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],mismatch(1,{leaseEpoch:2})).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],mismatch(1,{certificateDigests:[]})).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],mismatch(2,{treeSha:"a".repeat(40)})).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],mismatch(2,{reviewArtifactDigest:"a".repeat(64)})).closed,false);
});

test("durable scheduling, recovery and learning events receive named safe inspector labels",()=>{
  const view=projectLoom(mission(),plan(),[slice()],[ev(2,"scheduling.decision",{decisionId:"decision-1",status:"selected"}),ev(5,"check.recovery_pass",{sliceId:"s-1",attemptId:"attempt-1",strategyId:"strategy-2"}),ev(9,"lesson.withdrawn",{lessonId:"lesson-1",challengeDigest:"d".repeat(64)})]);
  assert.deepEqual(view.events.map(x=>x.label),["Scheduling decision recorded","Recovery check passed","Lesson withdrawn"]);
  assert(view.events[0]?.references.some(x=>x.kind==="decision"&&x.id==="decision-1"));assert(view.events[2]?.references.some(x=>x.kind==="lesson"&&x.digest==="d".repeat(64)));
});

test("empty, missing, hostile labels and mismatched mission records remain unavailable and text only", () => {
  assert.equal(projectLoom(null,plan(),[slice()],[]).state,"UNKNOWN");
  assert.equal(projectLoom(mission(),plan(),null,[]).closed,false);
  const hostile=ev(1,"<img src=x onerror=alert(1)>",{sliceId:"<svg onload=alert(1)>"});
  const view=projectLoom(mission(),plan(),[slice()],[hostile]); assert.equal(view.events[0]?.label,"Mission event"); assert.equal(view.events[0]?.sliceId,"<svg onload=alert(1)>");
  assert.equal(projectLoom(mission(),plan(),[slice()],[{...ev(1,"x"),missionId:"other"}]).state,"UNKNOWN");
});

test("approved plan membership and exact proof causality are required for closure",()=>{
  const good=completeEvents();
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],good).closed,true);
  assert.equal(projectLoom(mission("verified"),{...plan(),approvedAt:null},[slice("verified")],good).closed,false);
  assert.equal(projectLoom(mission("verified"),null,[slice("verified")],good).state,"UNKNOWN");
  assert.equal(projectLoom(mission("verified"),{...plan(),slices:[...plan().slices,{...plan().slices[0]!,id:"s-2"}]},[slice("verified")],good).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[{...slice("verified"),owner:"other"}],[...good]).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[{...slice("verified"),checks:["different-check"]}],good).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[{...slice("verified"),dependencies:["missing"]}],good).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[{...slice("verified"),scopes:["other/**"]}],good).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[{...slice("verified"),budgetCents:9}],good).closed,false);
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],[ev(2,"slice.integration_pending",good[1]!.data),ev(8,"check.certified",good[0]!.data),good[2]!]).closed,false,"strictly increasing cursors do not make a pending intent before certification causal");
  assert.equal(projectLoom(mission("verified"),plan(),[slice("verified")],[good[0]!,good[2]!,ev(21,"slice.integration_pending",good[1]!.data)]).closed,false,"an integration cannot precede its pending intent");
});

test("pending certificate IDs bind to certified checks independent of check order",()=>{
  const twoChecks={...slice("verified"),checks:["check:z","check:a"]};
  const twoCheckPlan={...plan(),slices:[{...plan().slices[0]!,checks:["check:z","check:a"]}]};
  const events=[
    ev(2,"check.certified",{sliceId:"s-1",certificateId:"cert-z",checkId:"check:z",leaseEpoch:1,candidateSha:"b".repeat(40)}),
    ev(4,"check.certified",{sliceId:"s-1",certificateId:"cert-a",checkId:"check:a",leaseEpoch:1,candidateSha:"b".repeat(40)}),
    ev(8,"slice.integration_pending",{sliceId:"s-1",leaseEpoch:1,candidateSha:"b".repeat(40),treeSha:"d".repeat(40),expectedIntegrationSha:"e".repeat(40),reviewArtifactDigest:"f".repeat(64),certificateIds:["cert-a","cert-z"],certificateDigests:["a".repeat(64),"c".repeat(64)]}),
    ev(13,"slice.integrated",{sliceId:"s-1",leaseEpoch:1,candidateSha:"b".repeat(40),treeSha:"d".repeat(40),reviewArtifactDigest:"f".repeat(64)})
  ];
  assert.equal(projectLoom(mission("verified"),twoCheckPlan,[twoChecks],events).closed,true);
});
