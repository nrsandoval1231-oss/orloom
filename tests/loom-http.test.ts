import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import type { MissionEvent } from "../packages/contracts/src/mission.js";

class PagedEventStore extends MemoryMissionStore {
  rows: MissionEvent[] = [];
  async events(id:string,after:number){return this.rows.filter(e=>e.missionId===id&&e.cursor>after).slice(0,1000);}
}

test("/loom uses a restrictive same-origin CSP and keeps mission reads owner-authenticated",async()=>{
  const token="owner-secret",store=new MemoryMissionStore();
  const one=await store.submit({repository:"owner/one",baseSha:"a".repeat(40),objective:"One mission",acceptance:["check"],budgetCents:10});
  const two=await store.submit({repository:"owner/two",baseSha:"b".repeat(40),objective:"Another mission",acceptance:["check"],budgetCents:10});
  const server=createControlPlane({mode:"local",port:0,sessionToken:token,workerToken:"worker-secret",capacitySlots:0,maxLanes:1,trustedCheckPolicy:[],trustedCheckPolicyDigest:"c".repeat(64)},new MemoryJobStore(),store);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  try{
    const page=await fetch(`${base}/loom?mission=${one.id}`);assert.equal(page.status,200);const html=await page.text();const csp=page.headers.get("content-security-policy")??"";
    assert.match(csp,/default-src 'none'/);assert.match(csp,/connect-src 'self'/);assert.match(csp,/script-src 'nonce-/);assert.doesNotMatch(csp,/https?:/);assert.match(html,/new URL\('\/api\/missions\//);assert(html.includes("'/checks/'+encodeURIComponent(e.checkId)+'/certificate'"));assert.match(html,/credentials:'same-origin'/);assert.match(html,/getContext\('webgl2'/);assert.match(html,/Mission weave WebGL fallback/);assert.doesNotMatch(html,/localStorage|sessionStorage|LoomSimulation|62\/100|innerHTML/);
    const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];assert(script);assert.doesNotThrow(()=>new Script(script));
    assert.equal((await fetch(`${base}/api/missions/${one.id}`)).status,401);
    assert.equal((await fetch(`${base}/api/missions/${one.id}/loom`)).status,401);
    const login=await fetch(`${base}/session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});const cookie=login.headers.get("set-cookie")?.split(";")[0];assert(cookie);
    const found=await fetch(`${base}/api/missions/${one.id}`,{headers:{cookie}});assert.equal(found.status,200);assert.equal((await found.json()).mission.id,one.id);
    assert.equal((await fetch(`${base}/api/missions/not-a-mission/events?after=0`,{headers:{cookie}})).status,200);assert.deepEqual(await (await fetch(`${base}/api/missions/not-a-mission/events?after=0`,{headers:{cookie}})).json(),[]);
    const certificatePath=`${base}/api/missions/${one.id}/slices/s-1/checks/check:unit/certificate`;assert.equal((await fetch(certificatePath)).status,401);assert.equal((await fetch(certificatePath,{headers:{cookie}})).status,503);
    const events=await (await fetch(`${base}/api/missions/${one.id}/events?after=0`,{headers:{cookie}})).json();assert(events.every((e:any)=>e.missionId===one.id));assert(!events.some((e:any)=>e.missionId===two.id));
    const replay=await (await fetch(`${base}/api/missions/${one.id}/events?after=0`,{headers:{cookie}})).json();assert.deepEqual(replay,events);assert.deepEqual(await (await fetch(`${base}/api/missions/${one.id}/events?after=${events.at(-1).cursor}`,{headers:{cookie}})).json(),[]);
    const projected=await (await fetch(`${base}/api/missions/${one.id}/loom`,{headers:{cookie}})).json();assert.equal(projected.projection.mission.id,one.id);assert.equal(projected.projection.closed,false);assert.equal(projected.projection.lastCursor,events.at(-1).cursor);assert.deepEqual(projected.events,events);
    assert.equal((await store.events(one.id,0)).length,events.length,"Loom reads do not create mission events");
    assert.equal((await fetch(`${base}/api/missions/${one.id}/events?after=-1`,{headers:{cookie}})).status,400);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test("Loom pages durable history after its SQL window, resumes from cursor, and distinguishes exact boundary from overflow",async()=>{
  const token="owner-secret",store=new PagedEventStore();const mission=await store.submit({repository:"owner/loom",baseSha:"a".repeat(40),objective:"Inspect history",acceptance:["check"],budgetCents:10});
  const server=createControlPlane({mode:"local",port:0,sessionToken:token,workerToken:"worker-secret",capacitySlots:0,maxLanes:1,trustedCheckPolicy:[],trustedCheckPolicyDigest:"c".repeat(64)},new MemoryJobStore(),store);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  try{
    const login=await fetch(`${base}/session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})}),cookie=login.headers.get("set-cookie")?.split(";")[0];assert(cookie);
    const request=(after=0)=>fetch(`${base}/api/missions/${mission.id}/loom?after=${after}`,{headers:{cookie}});
    store.rows=Array.from({length:2050},(_,i)=>({cursor:(i+1)*2,missionId:mission.id,type:"observation",data:{},createdAt:"2026-01-01T00:00:00Z"}));
    const first=await (await request()).json();assert.equal(first.events.length,1000);assert.equal(first.hasMore,true);assert.equal(first.nextCursor,2000);assert.equal(first.overflow,false);assert.equal(first.projection.lastCursor,4100);
    const resumed=await (await request(first.nextCursor)).json();assert.equal(resumed.events.length,1000);assert.equal(resumed.events[0].cursor,2002);assert.equal(resumed.hasMore,true);assert.equal(resumed.overflow,false);
    const replay=await (await request()).json();assert.deepEqual(replay.events,first.events,"a reconnect from cursor zero replays the bounded first page");
    const final=await (await request(resumed.nextCursor)).json();assert.equal(final.events.length,50);assert.equal(final.hasMore,false);assert.equal(final.nextCursor,4100);
    store.rows=Array.from({length:1000},(_,i)=>({cursor:i+1,missionId:mission.id,type:"observation",data:{},createdAt:"2026-01-01T00:00:00Z"}));
    const exact=await (await request()).json();assert.equal(exact.events.length,1000);assert.equal(exact.hasMore,false);assert.equal(exact.overflow,false);
    store.rows=Array.from({length:10001},(_,i)=>({cursor:i+1,missionId:mission.id,type:"observation",data:{},createdAt:"2026-01-01T00:00:00Z"}));
    const over=await (await request()).json();assert.equal(over.overflow,true);assert.equal(over.projection.state,"UNKNOWN");assert.equal(over.projection.closed,false);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
