import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import type { MissionStore, SliceInput } from "../packages/contracts/src/mission.js";
import { MissionGovernor } from "../packages/governor/src/governor.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";

const policy="c".repeat(64), recovery="d".repeat(64);
const strategies={"strategy:unit":{checkId:"check:unit",version:"v1",expectedSignal:"pass",scopeClasses:["src"],targetCheckIds:["check:unit"]}};
const config={mode:"local" as const,port:0,sessionToken:"fixture-owner",workerToken:"fixture-worker",capacitySlots:2,maxLanes:6,trustedCheckPolicy:["check:unit"],trustedCheckPolicyDigest:policy,recoveryPolicyDigest:recovery,workerMaxProviderCalls:2,workerMaxInputTokens:2000,workerMaxOutputTokens:1000,workerMaxWallSeconds:300,workerAllowedProviders:["fixture"],workerAllowedModels:["fixture"]};
const slice=(id:string,checks=["check:unit"],dependencies:string[]=[]):SliceInput=>({id,objective:id,dependencies,owner:"core",scopes:[`src/${id}`],checks,budgetCents:100});
async function fixture(kind:"memory"|"sql", overrides:Partial<typeof config>&{trustedStrategies?:typeof strategies}={}){
  const db=kind==="sql"?new PGlite():null;
  if(db)for(const file of (await readdir("db/migrations")).filter(x=>x.endsWith(".sql")).sort())await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
  const sql:TransactionalSql={query:async(text,params)=>(await db!.query(text,params)) as any,transaction:async work=>{await db!.exec("BEGIN");try{const result=await work(sql);await db!.exec("COMMIT");return result;}catch(error){await db!.exec("ROLLBACK");throw error;}}};
  const store:MissionStore=db?new SqlMissionStore(sql):new MemoryMissionStore();
  await store.configureCapacity(2,"b".repeat(64),new Date(Date.now()+3600000).toISOString());
  const server=createControlPlane({...config,...overrides},new MemoryJobStore(),store);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  return{store,async plan(slices:SliceInput[]){const governor=new MissionGovernor(store,{maxLanes:6,capacitySlots:2,leaseSeconds:300,trustedCheckPolicyDigest:policy,trustedCheckPolicy:slices.flatMap(s=>s.checks),executionConfigured:true});const mission=await governor.submit({repository:"fixture/repo",baseSha:"a".repeat(40),objective:"claim regression",acceptance:["safe lease"],budgetCents:1000});await governor.recommend(mission.id,slices,"owner");await governor.approve(mission.id);return mission.id;},claim:()=>fetch(`${base}/api/worker/claim`,{method:"POST",headers:{authorization:"Bearer fixture-worker"}}),base,async close(){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await db?.close();}};
}
for(const kind of ["memory","sql"] as const){
  test(`${kind}: direct store claims fail closed without a current allowlist`,async()=>{
    const ctx=await fixture(kind);try{
      const id=await ctx.plan([slice("a")]);
      assert.equal(await ctx.store.claim(300,policy,[]),null);
      assert.equal(await ctx.store.claim(300,policy,undefined as unknown as string[]),null,"untyped callers cannot omit the required policy");
      assert.equal((await ctx.store.schedulingSnapshot!(policy,recovery,[])).choices.length,0);
      const grant=await ctx.store.claim(300,policy,["check:unit"]);assert(grant);assert.equal(grant.mission.id,id);assert.equal(grant.mission.status,"running");assert.equal(grant.mission.reservedCents,100);
    }finally{await ctx.close();}
  });
  test(`${kind}: HTTP lease digest is authoritative and works unchanged in progress`,async()=>{
    const ctx=await fixture(kind,{trustedStrategies:strategies});try{
      const id=await ctx.plan([slice("a",["strategy:unit"])]),response=await ctx.claim();assert.equal(response.status,200);const lease=await response.json();
      const binding=await ctx.store.recoveryPolicyLease(id,"a",lease.leaseEpoch,lease.leaseToken,lease.capabilityToken);
      assert.equal(lease.planDigest,binding.planDigest);
      const record=await ctx.store.getMission(id);assert.equal(lease.planDigest,createHash("sha256").update(canonicalJson(record!.plan!.slices)).digest("hex"));
      const headers={authorization:`Bearer ${lease.capabilityToken}`,"x-orloom-lease-token":lease.leaseToken,"x-orloom-lease-epoch":String(lease.leaseEpoch),"content-type":"application/json"};
      const body={version:"orloom.progress.v1",eventId:randomUUID(),missionId:id,sliceId:"a",leaseEpoch:lease.leaseEpoch,ordinal:1,planDigest:lease.planDigest,trustedCheckPolicyDigest:lease.trustedCheckPolicyDigest,recoveryPolicyDigest:recovery,phase:"trusted_check",status:"started",reasonCode:"other",strategyId:"strategy:unit",targetCheckId:"check:unit",checkId:"check:unit",counters:{providerCalls:0,inputTokens:0,outputTokens:0,wallMs:0},evidenceRefs:[]};
      const progress=await fetch(`${ctx.base}/api/worker/missions/${id}/slices/a/progress`,{method:"POST",headers,body:JSON.stringify(body)});assert.equal(progress.status,200,await progress.text());
    }finally{await ctx.close();}
  });
  test(`${kind}: restarted HTTP policy rejects a stale whole plan before reserving or binding a lease`,async()=>{
    const ctx=await fixture(kind,{trustedCheckPolicyDigest:"e".repeat(64)});try{
      const id=await ctx.plan([slice("a"),slice("b",["check:removed"],["a"])]);
      assert.equal((await ctx.claim()).status,204);
      const record=(await ctx.store.getMission(id))!;assert.equal(record.mission.reservedCents,0);assert.equal(record.mission.status,"ready");assert(record.slices.every(s=>s.leaseEpoch===0));assert(!(await ctx.store.events(id,0)).some(e=>e.type==="slice.claimed"));
      const valid=await ctx.plan([slice("valid")]);const response=await ctx.claim();assert.equal(response.status,200);const lease=await response.json();assert.equal(lease.mission.id,valid);assert.equal(lease.trustedCheckPolicyDigest,"e".repeat(64));
    }finally{await ctx.close();}
  });
  for(const status of ["unknown","blocked"] as const)test(`${kind}: independent HTTP claim preserves ${status} aggregate and quarantine`,async()=>{
    const ctx=await fixture(kind);try{
      const id=await ctx.plan([slice("a"),slice("b")]),first=await(await ctx.claim()).json();
      if(status==="unknown")await ctx.store.expire(new Date(Date.parse(first.leaseExpiresAt)+1));
      else await ctx.store.reportOutcome(id,first.slice.id,first.leaseEpoch,first.leaseToken,first.capabilityToken,"BLOCKED","other",[]);
      assert.equal((await ctx.store.getMission(id))!.mission.status,status);
      const response=await ctx.claim();assert.equal(response.status,200);const second=await response.json();assert.notEqual(first.capacitySlot,second.capacitySlot);
      const record=(await ctx.store.getMission(id))!;assert.equal(record.mission.status,status);assert.equal(record.mission.reservedCents,200);assert.deepEqual(record.slices.map(s=>s.status).sort(),[status,"running"].sort());
      await assert.rejects(ctx.store.heartbeat(id,first.slice.id,first.leaseEpoch,first.leaseToken,first.capabilityToken,300));
      assert.equal((await ctx.claim()).status,204);
    }finally{await ctx.close();}
  });
}
