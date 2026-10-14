import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
const hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
test("bounded candidate reader rejects oversized and tampered bodies and aborts stalled streams",async()=>{
 const modulePath="../packages/adapters/src/candidate-artifacts.js";let api:any;try{api=await import(modulePath);}catch{assert.fail("bounded candidate artifact reader is unavailable");}
 const bytes=Buffer.from("candidate bytes"),key=`sha256/${hash(bytes)}`;
 let sends=0;const source=api.createR2CandidateArtifacts({accountId:"fixture",accessKeyId:"fixture",secretAccessKey:"fixture",bucket:"fixture"},{async send(command:any,options:any){sends++;assert.equal(command.input.Range,"bytes=0-100");assert(options.abortSignal instanceof AbortSignal);return {Body:Readable.from([bytes]),ContentLength:bytes.length};}});
 assert.deepEqual(Buffer.from(await source.getBounded(key,100,new AbortController().signal)),bytes);assert.equal(sends,1);
 const oversized=Readable.from([Buffer.alloc(101)]);const bad=api.createR2CandidateArtifacts({accountId:"fixture",accessKeyId:"fixture",secretAccessKey:"fixture",bucket:"fixture"},{async send(){return {Body:oversized};}});
 await assert.rejects(bad.getBounded(key,100,new AbortController().signal),/bound/);assert.equal(oversized.destroyed,true);
 const forged=api.createR2CandidateArtifacts({accountId:"fixture",accessKeyId:"fixture",secretAccessKey:"fixture",bucket:"fixture"},{async send(){return {Body:Readable.from([Buffer.from("fake")])};}});
 await assert.rejects(forged.getBounded(key,100,new AbortController().signal),/digest/);
 const stalled=new Readable({read(){}});const waiting=api.createR2CandidateArtifacts({accountId:"fixture",accessKeyId:"fixture",secretAccessKey:"fixture",bucket:"fixture"},{async send(){return {Body:stalled};}});
 const cancellation=new AbortController();const pending=waiting.getBounded(key,100,cancellation.signal);setTimeout(()=>cancellation.abort(),10);await assert.rejects(pending);assert.equal(stalled.destroyed,true);
});
