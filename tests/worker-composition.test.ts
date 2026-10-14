import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import type { ProgressV1, RecoveryProgress } from "../packages/contracts/src/mission.js";
import { loadConfig } from "../packages/config/src/config.js";
import { HttpRecoveryControlPlane } from "../packages/agents/src/recovery-control.js";
const hash = (x: string) => createHash("sha256").update(x).digest("hex");

test("composed recovery transport uses real Governor and refuses forged builder verification", async () => {
  const config = loadConfig({ORLOOM_MODE:"local", PORT:"3000", ORLOOM_SESSION_TOKEN:"owner-fixture", ORLOOM_WORKER_TOKEN:"worker-fixture",
    ORLOOM_CAPACITY_SLOTS:"1", ORLOOM_CAPACITY_EVIDENCE_VERIFIED:"true", ORLOOM_CAPACITY_EVIDENCE_SHA256:hash("fixture"), ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT:new Date(Date.now()+600000).toISOString(),
    ORLOOM_TRUSTED_CHECK_POLICY_JSON:JSON.stringify(["target", "check"]), ORLOOM_TRUSTED_STRATEGIES_JSON:JSON.stringify({"strategy":{checkId:"check",version:"v1",expectedSignal:"pass",scopeClasses:["src"],targetCheckIds:["target"]}}),
    ORLOOM_WORKER_MAX_PROVIDER_CALLS:"4",ORLOOM_WORKER_MAX_INPUT_TOKENS:"1000",ORLOOM_WORKER_MAX_OUTPUT_TOKENS:"1000",ORLOOM_WORKER_MAX_WALL_SECONDS:"60",ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON:'["deepseek"]',ORLOOM_WORKER_ALLOWED_MODELS_JSON:'["fixture"]'});
  const store = new MemoryMissionStore();
  await store.configureCapacity(1, hash("fixture"), new Date(Date.now()+600000).toISOString());
  const mission = await store.submit({repository:"owner/repo",baseSha:"a".repeat(40),objective:"fixture",acceptance:["pass"],budgetCents:100});
  await store.recommendPlan(mission.id,[{id:"slice",objective:"fixture",dependencies:[],owner:"builder",scopes:["src/**"],checks:["strategy"],budgetCents:100}],"owner");
  await store.approvePlan(mission.id);
  const server = createControlPlane(config,new MemoryJobStore(),store);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const address=server.address(); assert(address && typeof address!=="string");
    const client=new HttpRecoveryControlPlane(`http://127.0.0.1:${address.port}`,"worker-fixture");
    const lease=await client.claim(); assert(lease);
    const binding=await store.recoveryPolicyLease(mission.id,"slice",lease.leaseEpoch,lease.leaseToken,lease.capabilityToken);
    assert.equal(lease.planDigest,binding.planDigest,"HTTP claim must preserve the authoritative immutable plan digest");
    const policy=await client.recoveryPolicy(lease);
    const progress:ProgressV1={version:"orloom.progress.v1",eventId:"start-fixture",missionId:mission.id,sliceId:"slice",leaseEpoch:lease.leaseEpoch,ordinal:1,...binding,phase:"trusted_check",status:"started",reasonCode:"other",strategyId:"strategy",targetCheckId:"target",checkId:"check",counters:{providerCalls:0,inputTokens:0,outputTokens:0,wallMs:0},evidenceRefs:[]};
    assert.equal(policy.recoveryPolicyDigest,binding.recoveryPolicyDigest);
    const receipt=await client.recordProgress(lease,progress);
    assert.equal(receipt.action.action,"continue");
    const mutations: Array<[string, (value: Record<string, any>) => void]> = [
      ["missing judgment", value => { delete value.judgment; }],
      ["missing strategy on change", value => { value.action.action="change_strategy"; value.judgment.answer="change_strategy"; delete value.action.strategyId; }],
      ["missing check on change", value => { value.action.action="change_strategy"; value.judgment.answer="change_strategy"; delete value.action.checkId; }],
      ["missing revision", value => { delete value.action.revision; }],
      ["wrong snapshot digest", value => { value.judgment.snapshotDigest="f".repeat(64); }],
      ["mismatched judgment", value => { value.judgment.answer="request_replan"; }],
      ["foreign strategy", value => { value.action.action="change_strategy"; value.action.strategyId="foreign"; value.action.checkId="foreign"; value.judgment.answer="change_strategy"; value.judgment.strategyId="foreign"; value.judgment.checkId="foreign"; }],
      ["missing lessons", value => { delete value.action.lessonBindings; }],
      ["wrong counters", value => { value.snapshot.reportedUsage.providerCalls=3; }],
      ["unauthorized action field", value => { value.action.command="arbitrary"; }],
    ];
    for (const [name, mutate] of mutations) {
      const malformed=structuredClone(receipt) as unknown as Record<string, any>; mutate(malformed);
      let posts=0;
      const transport:typeof fetch=async (_url, init)=> {
        if(init?.method==="POST") posts++;
        return new Response(JSON.stringify(init?.method==="GET"?policy:malformed),{status:200});
      };
      const rejecting=new HttpRecoveryControlPlane("http://127.0.0.1:1","fixture",transport);
      await assert.rejects(rejecting.recordProgress(lease,progress),/invalid recovery receipt/,name);
      assert.equal(posts,1,"malformed committed response must not be replayed automatically");
    }

    assert.equal((await client.recordProgress(lease,progress)).duplicate,true);
    await assert.rejects(client.recoveryPolicy({...lease,planDigest:"f".repeat(64)}),/immutable lease/);
    await assert.rejects(client.recordProgress(lease,{...progress,phase:"provider"}),/trusted recovery/);
    await assert.rejects(client.recordProgress(lease,{...progress,status:"passed",reasonCode:"check_passed"}),/trusted recovery/);
    await assert.rejects(client.recordProgress(lease,{...progress,version:"orloom.progress.v2",eventId:"forged",ordinal:2,status:"passed",reasonCode:"check_passed",trustedAttemptId:"11111111-1111-1111-1111-111111111111",candidateSha:"c".repeat(40)} as RecoveryProgress),/HTTP 409/);
    await assert.rejects(client.recoveryPolicy({...lease,capabilityToken:"foreign"}),/HTTP/);
    assert.equal((await store.getMission(mission.id))?.slices[0]?.status,"running");
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test("normal worker executable refuses before loading credentials or contacting providers", () => {
  const result=spawnSync(process.execPath,["dist/apps/worker/src/main.js"],{env:{PATH:process.env.PATH??""},encoding:"utf8",timeout:5000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/independent candidate admission and cancellation reconciliation/);
  assert.equal(result.stdout,"");
});
