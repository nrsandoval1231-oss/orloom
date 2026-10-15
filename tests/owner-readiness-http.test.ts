import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";
import type { Config } from "../packages/config/src/config.js";

const token="owner-only-test-secret";
const config:Config={mode:"local",port:0,sessionToken:token,workerToken:"worker-secret",capacitySlots:0,maxLanes:1,trustedCheckPolicy:[],trustedCheckPolicyDigest:null};
function sql(db:PGlite):TransactionalSql{
  let tail=Promise.resolve();
  return {query:async(text,params)=>await db.query(text,params as never) as never,transaction:async<T>(work:(tx:{query:TransactionalSql["query"]})=>Promise<T>)=>{let release!:()=>void;const before=tail;tail=new Promise<void>(r=>release=r);return before.then(async()=>{try{await db.exec("BEGIN");const value=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return value;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}});}};
}
async function listen(store:MemoryMissionStore|SqlMissionStore){
  const server=createControlPlane(config,new MemoryJobStore(),store);await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  const login=await fetch(`${base}/session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});const cookie=login.headers.get("set-cookie")?.split(";")[0];assert(cookie);
  return {server,base,cookie};
}
async function close(server:ReturnType<typeof createControlPlane>){server.closeAllConnections();server.close();server.unref();}

test("owner Loom read requires owner session and is side-effect free with memory-store reconstruction",async()=>{
  const store=new MemoryMissionStore();const mission=await store.submit({repository:"owner/repo",baseSha:"a".repeat(40),objective:"read status",acceptance:["check"],budgetCents:100});
  await store.recommendPlan(mission.id,[{id:"slice",objective:"work",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100}],"owner");await store.approvePlan(mission.id);
  let app=await listen(store);
  try{
    assert.equal((await fetch(`${app.base}/api/missions/${mission.id}/loom`)).status,401);
    const eventsBefore=await store.events(mission.id,0);
    const response=await fetch(`${app.base}/api/missions/${mission.id}/loom`,{headers:{cookie:app.cookie}});assert.equal(response.status,200);
    const first=await response.json() as any;assert(first.projection.readiness,"Owner readiness projection must exist");assert.equal(first.projection.readiness.state,"unverified");assert.equal(first.projection.readiness.liveExecution,"unverified");assert.equal(first.projection.cancellation.state,"none");
    const serialized=JSON.stringify(first.projection.readiness);assert(!serialized.includes("worker-secret"));assert(!serialized.includes("sessionToken"));
    await close(app.server);app=await listen(store);
    const again=await (await fetch(`${app.base}/api/missions/${mission.id}/loom`,{headers:{cookie:app.cookie}})).json() as any;
    assert.deepEqual(again.projection.readiness,first.projection.readiness);assert.deepEqual(again.projection.cancellation,first.projection.cancellation);
    assert.deepEqual(await store.events(mission.id,0),eventsBefore,"owner GET does not append durable events");
  }finally{await close(app.server);}
});

test("owner Loom projection survives SQL store reload and keeps exact durable cancellation evidence",async()=>{
  const db=new PGlite();
  try{
    for(const file of (await readdir("db/migrations")).filter(file=>file.endsWith(".sql")).sort())await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
    const store=new SqlMissionStore(sql(db));const mission=await store.submit({repository:"owner/sql",baseSha:"b".repeat(40),objective:"persist status",acceptance:["check"],budgetCents:100});
    await store.recommendPlan(mission.id,[{id:"slice",objective:"work",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:100}],"owner");await store.approvePlan(mission.id);
    const identity={missionId:mission.id,sliceId:"slice",leaseEpoch:0,controllerRunId:"c".repeat(64)};
    await store.requestCancel!(mission.id,"owner-stop","stop before work");await store.settleCancellationBeforeRuntime!(identity);
    let app=await listen(new SqlMissionStore(sql(db)));
    try{
      const loaded=await (await fetch(`${app.base}/api/missions/${mission.id}/loom`,{headers:{cookie:app.cookie}})).json() as any;
      assert.equal(loaded.projection.cancellation.slices[0].state,"pre-runtime-settled");
      assert.equal(loaded.projection.cancellation.slices[0].leaseEpoch,0);
      await close(app.server);app=await listen(new SqlMissionStore(sql(db)));
      const reloaded=await (await fetch(`${app.base}/api/missions/${mission.id}/loom`,{headers:{cookie:app.cookie}})).json() as any;
      assert.deepEqual(reloaded.projection.cancellation,loaded.projection.cancellation);
    }finally{await close(app.server);}
  }finally{await db.close();}
});

test("inconsistent durable history makes owner readiness unavailable without adding events",async()=>{
  class ContradictoryHistory extends MemoryMissionStore {
    override async events(id:string,after:number){const rows=await super.events(id,after);return after===0&&rows.length?[rows[0]!,rows[0]!]:rows;}
  }
  const store=new ContradictoryHistory();
  const mission=await store.submit({repository:"owner/history",baseSha:"c".repeat(40),objective:"Observe incomplete history",acceptance:["no false readiness"],budgetCents:10});
  await store.recommendPlan(mission.id,[{id:"slice",objective:"work",dependencies:[],owner:"core",scopes:["src"],checks:["check:unit"],budgetCents:10}],"owner");await store.approvePlan(mission.id);
  const app=await listen(store);
  try{
    const response=await fetch(`${app.base}/api/missions/${mission.id}/loom`,{headers:{cookie:app.cookie}});
    assert.equal(response.status,200);
    const payload=await response.json() as any;
    assert.equal(payload.projection.state,"UNKNOWN");
    assert.equal(payload.projection.readiness.state,"unavailable");
    assert.equal(payload.projection.cancellation.state,"quarantined-unknown");
    assert.equal(payload.projection.closed,false);
  }finally{await close(app.server);}
});
