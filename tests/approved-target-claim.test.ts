import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import { MissionGovernor } from "../packages/governor/src/governor.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";
import type { MissionStore, ApprovedClaimTarget } from "../packages/contracts/src/mission.js";

const hash=(x:string)=>createHash("sha256").update(x).digest("hex");
async function setup(store:MissionStore){
  await store.configureCapacity(2,hash("capacity"),new Date(Date.now()+300_000).toISOString());
  const create=async(id:string,repository:string,baseSha:string,budget=100)=>{
    const m=await store.submit({repository,baseSha,objective:id,acceptance:["bounded"],budgetCents:budget});
    const slices=[{id:"only",objective:"work",dependencies:[],owner:"owner",scopes:[`src/${id}.ts`],checks:["check:ok"],budgetCents:40}];
    await store.recommendPlan(m.id,slices,"owner");await store.approvePlan(m.id);
    return {m,slices,target:{missionId:m.id,sliceId:"only",repository,baseSha,planDigest:hash(canonicalJson(slices)),maxBudgetCents:40} satisfies ApprovedClaimTarget};
  };
  return create;
}

test("approved target claim selects exact binding ahead of unrelated ready work and MissionGovernor skips scheduler",async()=>{
  const store=new MemoryMissionStore();const create=await setup(store);
  const unrelated=await create("unrelated","owner/unrelated","a".repeat(40));
  const desired=await create("desired","owner/desired","b".repeat(40));
  let schedulerCalls=0;
  const governor=new MissionGovernor(store,{maxLanes:2,capacitySlots:2,leaseSeconds:300,trustedCheckPolicyDigest:hash("policy"),trustedCheckPolicy:["check:ok"],executionConfigured:true},undefined,async()=>{schedulerCalls++;return {selectedCandidateId:"bad",modelId:"fixture",tokenUsage:{inputTokens:0,outputTokens:0}};});
  const grant=await governor.claimApproved(desired.target);
  assert.equal(grant?.mission.id,desired.m.id);assert.equal(grant?.slice.id,"only");assert.equal(schedulerCalls,0);
  assert.equal((await store.getMission(unrelated.m.id))?.slices[0]?.status,"ready");
});

test("approved target claim rejects changed bindings and missions without reserving anything",async()=>{
  const store=new MemoryMissionStore();const create=await setup(store);const good=await create("good","owner/good","c".repeat(40));
  const governor=new MissionGovernor(store,{maxLanes:2,capacitySlots:2,leaseSeconds:300,trustedCheckPolicyDigest:hash("policy"),trustedCheckPolicy:["check:ok"],executionConfigured:true});
  for(const changed of [{baseSha:"d".repeat(40)},{repository:"owner/other"},{planDigest:hash("wrong")},{maxBudgetCents:39}])assert.equal(await governor.claimApproved({...good.target,...changed}),null);
  assert.equal((await store.getMission(good.m.id))?.mission.reservedCents,0);
});

test("SQL approved target claim filters in the locked query and claims only its exact approved slice",async()=>{
  const {PGlite}=await import("@electric-sql/pglite");const db=new PGlite();
  const sql:TransactionalSql={query:(text,values)=>db.query(text,values),transaction:fn=>db.transaction(tx=>fn({query:(text,values)=>tx.query(text,values)}))};
  try{
    for(const file of (await readdir("db/migrations")).filter(x=>x.endsWith(".sql")).sort())await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
    const store=new SqlMissionStore(sql);const create=await setup(store);
    await create("unrelated","owner/unrelated","e".repeat(40));const desired=await create("desired","owner/desired","f".repeat(40));
    const grant=await store.claim(300,hash("policy"),["check:ok"],new Date(),"",undefined,desired.target);
    assert.equal(grant?.mission.id,desired.m.id);assert.equal((await store.getMission(desired.m.id))?.mission.reservedCents,40);
  }finally{await db.close();}
});
