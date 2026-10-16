import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore, type TransactionalSql } from "../packages/contracts/src/sql-mission-store.js";

const sha="a".repeat(40);
async function fill(store:{submit(input:{repository:string;baseSha:string;objective:string;acceptance:string[];budgetCents:number}):Promise<{id:string;createdAt:string}>},count:number){const rows=[];for(let i=0;i<count;i++)rows.push(await store.submit({repository:`owner/repo-${i}`,baseSha:sha,objective:`mission-${i}`,acceptance:["bounded"],budgetCents:100}));return rows}
function assertList(rows:Array<{id:string;createdAt:string}>,all:Array<{id:string;createdAt:string}>){const expected=[...all].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,51);assert.deepEqual(rows.map(x=>x.id),expected.map(x=>x.id));assert.equal(rows.length,51);assert.equal(rows.some(x=>"leaseToken" in x),false)}

test("memory mission listing is bounded, stable, newest-first, and rejects invalid limits",async()=>{const store=new MemoryMissionStore(),all=await fill(store,53),rows=await store.listMissions(51);assertList(rows,all.map(x=>({id:x.id,createdAt:x.createdAt})));await assert.rejects(()=>store.listMissions(0));await assert.rejects(()=>store.listMissions(52));});

test("SQL mission listing is bounded, stable, newest-first, and rejects invalid limits",async()=>{const {PGlite}=await import("@electric-sql/pglite"),db=new PGlite(),sql:TransactionalSql={query:(text,values)=>db.query(text,values),transaction:fn=>db.transaction(tx=>fn({query:(text,values)=>tx.query(text,values)}))};try{for(const file of (await readdir("db/migrations")).filter(x=>x.endsWith(".sql")).sort())await db.exec(await readFile(`db/migrations/${file}`,"utf8"));const store=new SqlMissionStore(sql),all=await fill(store,53);await db.exec("UPDATE missions SET created_at = TIMESTAMPTZ '2026-01-01 00:00:00+00'");const rows=await store.listMissions(51);assert.deepEqual(rows.map(x=>x.id),all.map(x=>x.id).sort().reverse().slice(0,51));assert.equal(rows.length,51);assert.equal(rows.some(x=>"leaseToken" in x),false);await assert.rejects(()=>store.listMissions(0));await assert.rejects(()=>store.listMissions(52));}finally{await db.close()}});
