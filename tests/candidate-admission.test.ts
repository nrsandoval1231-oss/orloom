import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, chmod, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { BareGitFastForwardIntegrator } from "../packages/integration/src/local.js";
const exec=promisify(execFile),hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");

test("profile path guard stays in parity with the baked suite admission policy",async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),"orloom-policy-parity-"));
 try {
  await writeFile(path.join(temp,"package.json"),await readFile("package.json"));
  await writeFile(path.join(temp,"package-lock.json"),await readFile("package-lock.json"));
  const suite=await import(pathToFileURL(path.resolve("infra/verifier-isolation/suite-policy.js")).href);
  const {forbiddenSuitePath}=await import("../packages/verification/src/repository.js");
  const vectors:[string,boolean][]=[
   ["package-lock.json",false],["docs/evidence/old-run.log",false],["docs/evidence/.npmrc",true],
   ["docs/evidence/credentials/secret.pem",true],["docs/evidence/.github/workflows/hidden.yml",true],
   ["docs/evidence/.env.production",true],["docs/evidence/secrets/token.txt",true],
   ["docs/evidence/package-lock.json.backup",true],["docs/evidence/yarn.lock",true],
   ["dist/generated.js",true],["docs/evidence/STATE/result.json",true],
   ["docs/evidence/node_modules/pkg/index.js",true],["docs/evidence/credentials.json",true],
   ["docs/evidence/id_ed25519",true],["docs/evidence/key.pfx",true],
   ["docs/evidence/npm-shrinkwrap.json",true],["docs/evidence/pnpm-lock.yaml",true],
   ["docs/evidence/bun.lockb",true],["docs/evidence/.yarnrc.yml",true],
   ["docs/evidence/.pnp.cjs",true],["Package-lock.json",true],
   ["docs/evidence/.env.example",false],["docs/evidence/ordinary.txt",false],
  ];
  for(const [file,expected] of vectors){
   assert.equal(forbiddenSuitePath(file),expected,`TypeScript policy vector ${file}`);
   const rejected=await suite.admitSuiteInput(temp,[{path:file}]).then(()=>false,()=>true);
   assert.equal(rejected,expected,`suite policy vector ${file}`);
  }
 }finally{await rm(temp,{recursive:true,force:true});}
});
async function git(root:string,...args:string[]) {return (await exec("git",["-C",root,"-c","user.name=Admission Fixture","-c","user.email=fixture@example.invalid",...args],{encoding:"utf8"})).stdout.trim();}
async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),"orloom-admission-"));
  const work=path.join(root,"work"),trusted=path.join(root,"trusted.git"),admissions=path.join(root,"admissions");
  await mkdir(work);await mkdir(admissions,{mode:0o700});await git(work,"init","-b","main");await mkdir(path.join(work,"src"));await writeFile(path.join(work,"src/a.js"),"export const a=1;\n");await git(work,"add",".");await git(work,"commit","-m","base");
  const baseSha=await git(work,"rev-parse","HEAD");await git(root,"clone","--bare",work,trusted);
  await writeFile(path.join(work,"src/a.js"),"export const a=2;\n");await git(work,"commit","-am","candidate");const candidateSha=await git(work,"rev-parse","HEAD");
  const bundlePath=path.join(root,"candidate.bundle");await git(work,"update-ref","refs/heads/orloom-candidate",candidateSha);await git(work,"bundle","create",bundlePath,"refs/heads/orloom-candidate",`^${baseSha}`);
  const bytes=await readFile(bundlePath),bundleKey=`sha256/${hash(bytes)}`,planDigest=hash("plan"),policyDigest=hash("policy");
  const binding={version:"orloom.candidate-admission.v1" as const,missionId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",sliceId:"slice",leaseEpoch:1,repository:"owner/repo",baseSha,candidateSha,planDigest,trustedCheckPolicyDigest:policyDigest,scopes:["src/**"],evidenceRefs:[] as string[]};
  const index=Buffer.from(JSON.stringify({version:"orloom.worker-evidence-index.v1",missionId:binding.missionId,sliceId:binding.sliceId,leaseEpoch:binding.leaseEpoch,baseSha,planDigest,trustedCheckPolicyDigest:policyDigest,entries:[{name:"candidate-bundle",key:bundleKey,sha256:hash(bytes),reference:`candidate-bundle:${bundleKey}`}]}));
  const indexKey=`sha256/${hash(index)}`;binding.evidenceRefs=[`candidate-bundle:${bundleKey}`,`evidence-index:${indexKey}`];
  const values=new Map<string,Buffer>([[bundleKey,bytes],[indexKey,index]]);
  const artifacts={async getBounded(key:string,maxBytes:number){const value=values.get(key);if(!value||value.length>maxBytes)throw new Error("fixture artifact absent or oversized");return new Uint8Array(value);}};
  return {root,work,trusted,admissions,binding,values,bundleKey,indexKey,artifacts};
}


function retain(f:Awaited<ReturnType<typeof fixture>>,bytes:Buffer,updates:Partial<typeof f.binding>={}) {
 const binding={...f.binding,...updates},key=`sha256/${hash(bytes)}`;
 const index=Buffer.from(JSON.stringify({version:"orloom.worker-evidence-index.v1",missionId:binding.missionId,sliceId:binding.sliceId,leaseEpoch:binding.leaseEpoch,baseSha:binding.baseSha,planDigest:binding.planDigest,trustedCheckPolicyDigest:binding.trustedCheckPolicyDigest,entries:[{name:"candidate-bundle",key,sha256:hash(bytes),reference:`candidate-bundle:${key}`}]}));
 const indexKey=`sha256/${hash(index)}`;f.values.set(key,bytes);f.values.set(indexKey,index);binding.evidenceRefs=[`candidate-bundle:${key}`,`evidence-index:${indexKey}`];return binding;
}
async function repack(f:Awaited<ReturnType<typeof fixture>>) {
 const candidateSha=await git(f.work,"rev-parse","HEAD"),file=path.join(f.root,"next.bundle");
 await git(f.work,"update-ref","refs/heads/orloom-candidate",candidateSha);await git(f.work,"bundle","create",file,"refs/heads/orloom-candidate",`^${f.binding.baseSha}`);
 return {candidateSha,bytes:await readFile(file)};
}

test("controller admits exact worker bundle into a private verifier source without moving trusted HEAD",async()=>{
 const f=await fixture();try {
  const modulePath="../packages/verification/src/candidate-admission.js";
  let api:any;try {api=await import(modulePath);}catch {assert.fail("controller-owned candidate admission is unavailable");}
  const admission=new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const first=await admission.admit(f.binding);
  assert.equal(first.input.files.get("src/a.js").toString(),"export const a=2;\n");
  assert.equal(first.receipt.candidateSha,f.binding.candidateSha);
  assert.equal(first.receipt.bundleDigest,f.bundleKey.slice(7));
  assert.equal(await git(f.trusted,"rev-parse","refs/heads/main"),f.binding.baseSha);
  assert.equal(await git(first.repository.objectStore,"rev-parse",first.repository.approvedRef),f.binding.candidateSha);
  const second=await admission.admit(f.binding);assert.equal(second.receipt.admissionDigest,first.receipt.admissionDigest);assert.equal(second.repository.objectStore,first.repository.objectStore);
 } finally {await rm(f.root,{recursive:true,force:true});}
});


test("admission rejects forged artifacts, identity, scopes and malformed bundles before publishing",async()=>{
 const f=await fixture();try {
  const api=await import("../packages/verification/src/candidate-admission.js");
  const options={root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts};
  const admission=new api.CandidateAdmission(options);
  for(const update of [{candidateSha:"f".repeat(40)},{baseSha:"e".repeat(40)},{planDigest:"d".repeat(64)},{repository:"foreign/repo"},{leaseEpoch:2},{scopes:["docs/**"]},{evidenceRefs:[...f.binding.evidenceRefs,`candidate-bundle:${f.bundleKey}`]}]){
    await assert.rejects(admission.admit({...f.binding,...update}));
  }
  const original=f.values.get(f.bundleKey)!;f.values.set(f.bundleKey,Buffer.from("forged"));
  await assert.rejects(admission.admit(f.binding),/digest/);f.values.set(f.bundleKey,original);
  const admitted=await admission.admit(f.binding);
  await mkdir(path.join(admitted.repository.objectStore,"info"),{recursive:true});
  await writeFile(path.join(admitted.repository.objectStore,"info/grafts"),`${f.binding.candidateSha}\n`);
  await assert.rejects(admission.admit(f.binding),/graft|unsafe|refused/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("admission serializes concurrent imports, cancels queued work, and rejects private-root symlinks",async()=>{
 const f=await fixture();try {
  const api=await import("../packages/verification/src/candidate-admission.js");
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const didStart=new Promise<void>(resolve=>{started=resolve;});
  const admission=new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:{async getBounded(key,max){started();await blocked;return f.artifacts.getBounded(key,max);}}});
  const first=admission.admit(f.binding);await didStart;
  const same=admission.admit(f.binding);
  const queuedCancellation=new AbortController();
  const queued=admission.admit({...f.binding,sliceId:"other"},queuedCancellation.signal);queuedCancellation.abort();
  await assert.rejects(queued,/cancel/);
  release();const [a,b]=await Promise.all([first,same]);assert.equal(a.receipt.admissionDigest,b.receipt.admissionDigest);
  const link=path.join(f.root,"root-link");await symlink(f.admissions,link);
  await assert.rejects(new api.CandidateAdmission({root:link,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts}).admit(f.binding),/private/);
  await chmod(f.admissions,0o755);await assert.rejects(admission.admit(f.binding),/private/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});


test("admission cancellation aborts an outstanding artifact read and releases capacity",async()=>{
 const f=await fixture();try {
  const api=await import("../packages/verification/src/candidate-admission.js");let observed:AbortSignal|undefined;let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const admission=new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:{getBounded(_key,_max,signal){observed=signal;started();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("artifact transport aborted")),{once:true}));}}});
  const cancellation=new AbortController();const pending=admission.admit(f.binding,cancellation.signal);await ready;cancellation.abort();
  await assert.rejects(pending,/abort|deadline/);assert.equal(observed?.aborted,true);
  const good=new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});assert.equal((await good.admit(f.binding)).receipt.candidateSha,f.binding.candidateSha);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("fixed integration store imports only admitted objects and leaves its authority ref unchanged",async()=>{
 const f=await fixture();try {
  const api=await import("../packages/verification/src/candidate-admission.js");
  const admission=new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const admitted=await admission.admit(f.binding);
  assert.equal((await stat(admitted.repository.objectStore)).mode&0o077,0,"admitted bare object store remains private for certified import");
  const target=path.join(f.root,"integration.git"),template=path.join(f.root,"empty-template");await mkdir(template);
  await exec("git",["clone","--bare",`--template=${template}`,f.trusted,target]);await git(target,"update-ref","refs/heads/orloom-integration",f.binding.baseSha);
  const integrator=await BareGitFastForwardIntegrator.open(target,"owner/repo");
  const result=await integrator.importAdmittedCandidate(admitted.repository,f.binding.candidateSha,f.binding.baseSha,["src"]);
  assert.equal(result.candidateSha,f.binding.candidateSha);assert.equal(result.previousSha,f.binding.baseSha);assert.deepEqual(result.changedPaths,["src/a.js"]);
  assert.equal(await integrator.readRef(),f.binding.baseSha,"object import must not promote the integration ref");
  const ref=path.join(admitted.repository.objectStore,"refs","heads","admitted-candidate");await writeFile(ref,`${f.binding.baseSha}\n`);
  await assert.rejects(integrator.importAdmittedCandidate(admitted.repository,f.binding.candidateSha,f.binding.baseSha,["src"]),/exact candidate|source ref/);
  assert.equal(await integrator.readRef(),f.binding.baseSha,"substitution rejection cannot advance the integration ref");
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("candidate runner binds exact source and shares its independent verifier without trusting builder success",async()=>{
 const f=await fixture();try {
  const api=await import("../packages/verification/src/candidate-admission.js");const modulePath="../packages/verification/src/admitting-runner.js";
  let factory:any;try{factory=await import(modulePath);}catch{assert.fail("candidate-bound verifier factory is unavailable");}
  const {DurableArtifactStore}=await import("../packages/verification/src/artifact-store.js");
  let launches=0;
  const runner=new factory.AdmittingVerificationRunner({repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:new DurableArtifactStore(path.join(f.root,"verification-evidence")),verifierId:"fixture",image:`sha256:${"a".repeat(64)}`,imageDigest:"a".repeat(64),launcher:{async launch(){launches++;throw new Error("No isolated runtime is activated in this source test");}}},new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts}));
  await assert.rejects(runner.prepareBundle("owner/repo",f.binding.baseSha,f.binding.candidateSha),/admission/);
  const bound=await runner.forCandidate(f.binding);
  const input=await bound.prepareBundle("owner/repo",f.binding.baseSha,f.binding.candidateSha);assert.equal(input.files.get("src/a.js").toString(),"export const a=2;\n");
  assert.equal((await bound.observeHead("owner/repo")).sha,f.binding.candidateSha);
  await assert.rejects(bound.prepareBundle("owner/repo",f.binding.baseSha,"f".repeat(40)),/binding/);
  await assert.rejects(bound.observeHead("foreign/repo"),/binding/);
  await assert.rejects(bound.run({repository:"foreign/repo"},input),/binding/);
  assert.equal(launches,0,"malformed requests cannot enter the independent verifier");
 }finally{await rm(f.root,{recursive:true,force:true});}
});


test("correctly hashed hostile bundle envelopes and packs are rejected inside admission",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const original=f.values.get(f.bundleKey)!,end=original.indexOf("\n\n");
  const extraHead=Buffer.concat([original.subarray(0,end),Buffer.from(`\n${f.binding.candidateSha} refs/heads/extra`),original.subarray(end)]);
  const wrongBase=Buffer.from(original);Buffer.from("f".repeat(40)).copy(wrongBase,original.indexOf(`-${f.binding.baseSha}`)+1);
  const highCount=Buffer.from(original);highCount.writeUInt32BE(12001,end+10);
  const mutations=[extraHead,wrongBase,highCount,original.subarray(0,original.length-15),Buffer.from("# v2 git bundle\n"+"x".repeat(17000)+"\n\nPACK")];
  for(const bytes of mutations)await assert.rejects(admission.admit(retain(f,bytes)),/admission refused/);
  await git(f.work,"commit","--allow-empty","-m","second commit");let candidate=await repack(f);await assert.rejects(admission.admit(retain(f,candidate.bytes,{candidateSha:candidate.candidateSha})),/direct child/);
  await git(f.work,"reset","--hard",f.binding.baseSha);await symlink("a.js",path.join(f.work,"src/link"));await git(f.work,"add",".");await git(f.work,"commit","-m","symlink");candidate=await repack(f);await assert.rejects(admission.admit(retain(f,candidate.bytes,{candidateSha:candidate.candidateSha})),/symlink|unsupported/);
  await git(f.work,"reset","--hard",f.binding.baseSha);await git(f.work,"rm","src/a.js");await git(f.work,"commit","-m","delete");candidate=await repack(f);await assert.rejects(admission.admit(retain(f,candidate.bytes,{candidateSha:candidate.candidateSha,scopes:["docs/**"]})),/scope/i);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("cached commit-object substitution is refused despite matching tree and manifest",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const admitted=await admission.admit(f.binding),sha=f.binding.candidateSha;
  const raw=(await exec("git",["--git-dir",admitted.repository.objectStore,"cat-file","commit",sha],{encoding:"buffer"})).stdout;
  const altered=Buffer.concat([raw,Buffer.from("tampered message\n")]);const object=Buffer.concat([Buffer.from(`commit ${altered.length}\0`),altered]);
  assert.notEqual(createHash("sha1").update(object).digest("hex"),sha);
  const directory=path.join(admitted.repository.objectStore,"objects",sha.slice(0,2));await mkdir(directory,{recursive:true});await writeFile(path.join(directory,sha.slice(2)),deflateSync(object));
  await assert.rejects(admission.admit(f.binding),/Git operation|identity/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("distinct concurrent candidates retain independent admission identities and private heads",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  await git(f.work,"reset","--hard",f.binding.baseSha);await writeFile(path.join(f.work,"src/b.js"),"export const b=3;\n");await git(f.work,"add",".");await git(f.work,"commit","-m","independent b");const candidate=await repack(f);
  const second=retain(f,candidate.bytes,{candidateSha:candidate.candidateSha,sliceId:"slice-b",scopes:["src/b.js"]});
  const first=retain(f,f.values.get(f.bundleKey)!,{scopes:["src/a.js"]});
  const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const [a,b]=await Promise.all([admission.admit(first),admission.admit(second)]);
  assert.notEqual(a.repository.objectStore,b.repository.objectStore);assert.notEqual(a.receipt.admissionDigest,b.receipt.admissionDigest);
  assert.equal(a.input.files.get("src/a.js")?.toString(),"export const a=2;\n");assert.equal(b.input.files.get("src/a.js")?.toString(),"export const a=1;\n");assert.equal(b.input.files.get("src/b.js")?.toString(),"export const b=3;\n");
  assert.equal(await git(f.trusted,"rev-parse","refs/heads/main"),f.binding.baseSha);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("bounded admission queue saturation stays transient and cancelled waiters never read artifacts",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const {CandidateAdmissionTransientError}=await import("../packages/contracts/src/verification.js");
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let reads=0;
  const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:{async getBounded(){reads++;started();return new Promise<Uint8Array>(()=>{});}}});
  const controllers=Array.from({length:7},()=>new AbortController());
  const first=admission.admit(f.binding,controllers[0]!.signal);const results=[assert.rejects(first,CandidateAdmissionTransientError)];await ready;
  for(let i=1;i<7;i++)results.push(assert.rejects(admission.admit({...f.binding,sliceId:`queued-${i}`},controllers[i]!.signal),CandidateAdmissionTransientError));
  await assert.rejects(admission.admit({...f.binding,sliceId:"overflow"}),CandidateAdmissionTransientError);
  for(const controller of controllers.slice(1))controller.abort();controllers[0]!.abort();await Promise.all(results);assert.equal(reads,1);
  const good=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  assert.equal((await good.admit(f.binding)).receipt.candidateSha,f.binding.candidateSha);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("persisted coordinator retries transient admission and binds certificate readback to private candidate head",async()=>{
 const f=await fixture();const {PGlite}=await import("@electric-sql/pglite");const db=new PGlite();
 try {
  const {SqlMissionStore}=await import("../packages/contracts/src/sql-mission-store.js");
  const {TrustedCheckCoordinator}=await import("../packages/governor/src/governor.js");
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const {AdmittingVerificationRunner}=await import("../packages/verification/src/admitting-runner.js");
  const {DurableArtifactStore}=await import("../packages/verification/src/artifact-store.js");
  const {getCheckPolicy}=await import("../packages/verification/src/policy.js");
  const {canonicalJson}=await import("../packages/judgment/src/canonical.js");
  for(const file of ["001_initial.sql","002_missions.sql","003_recovery.sql","004_verification.sql","005_learning.sql"])await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
  let gate=Promise.resolve();const sql:import("../packages/contracts/src/sql-mission-store.js").TransactionalSql={query:async(text,params)=>await db.query(text,params as never) as never,transaction:async work=>{let release!:()=>void;const prior=gate;gate=new Promise<void>(resolve=>{release=resolve;});await prior;try{await db.exec("BEGIN");const result=await work({query:async(text,params)=>await db.query(text,params as never) as never});await db.exec("COMMIT");return result;}catch(error){await db.exec("ROLLBACK");throw error;}finally{release();}}};
  const store=new SqlMissionStore(sql);await store.configureCapacity(1,"b".repeat(64),new Date(Date.now()+120_000).toISOString());
  const mission=await store.submit({repository:f.binding.repository,baseSha:f.binding.baseSha,objective:"admit candidate",acceptance:["exact persisted candidate"],budgetCents:100});
  await store.recommendPlan(mission.id,[{id:"slice",objective:"candidate",dependencies:[],owner:"core",scopes:["src/**"],checks:["node-validate-syntax"],budgetCents:100}],"owner-session");await store.approvePlan(mission.id);
  const grant=await store.claim(300,f.binding.trustedCheckPolicyDigest,["node-validate-syntax"]);assert(grant);
  const record=await store.getMission(mission.id);assert(record?.plan);
  const binding=retain(f,f.values.get(f.bundleKey)!,{missionId:mission.id,leaseEpoch:grant.epoch,planDigest:hash(canonicalJson(record.plan.slices))});
  await store.complete(mission.id,"slice",grant.epoch,grant.leaseToken,grant.capabilityToken,binding.candidateSha,binding.evidenceRefs);
  let unavailable=true,launches=0;
  const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:{async getBounded(key,max){if(unavailable)throw new Error("temporary artifact outage");return f.artifacts.getBounded(key,max);}}});
  const imageDigest="a".repeat(64),image=`sha256:${imageDigest}`,policy=getCheckPolicy("node-validate-syntax",image,imageDigest);
  const runner=new AdmittingVerificationRunner({repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:new DurableArtifactStore(path.join(f.root,"verification")),verifierId:"controlled-fixture",image,imageDigest,launcher:{async launch(_policy,input){launches++;assert.equal(input.files.get("src/a.js")?.toString(),"export const a=2;\n");return {sandboxId:"controlled-fixture-only",exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}}},admission);
  const coordinator=new TrustedCheckCoordinator(store,runner,{imageDigest,verifierId:"controlled-fixture",policyDigest:policy.digest,leasePolicyDigest:binding.trustedCheckPolicyDigest,policyVersion:policy.version,allowedChecks:[policy.id],attemptLifetimeMs:60_000});
  await assert.rejects(coordinator.prepare(mission.id,"slice",policy.id),/unavailable/);
  assert.equal((await store.awaitingVerification!([policy.id])).length,1,"transient admission must remain eligible");
  assert.equal((await store.events(mission.id,0)).filter(e=>e.type==="check.unknown").length,0);
  unavailable=false;await coordinator.verifySlice(mission.id,"slice");assert.equal(launches,1);
  const certificate=await coordinator.getCertificate(mission.id,"slice",policy.id);assert(certificate);
  assert.equal(certificate.candidateSha,binding.candidateSha);assert.equal(await git(f.trusted,"rev-parse","refs/heads/main"),binding.baseSha);
  const admitted=await admission.admit(binding);await git(admitted.repository.objectStore,"update-ref",admitted.repository.approvedRef,binding.baseSha);
  assert.equal(await coordinator.getCertificate(mission.id,"slice",policy.id),null,"private head mutation hides certificate");
 }finally{await db.close();await rm(f.root,{recursive:true,force:true});}
});

test("same-binding callers have independent cancellation while admission cache stays reusable",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;}),wait=new Promise<void>(r=>{release=r;});
  const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:{async getBounded(key,max){started();await wait;return f.artifacts.getBounded(key,max);}}});
  const first=admission.admit(f.binding);await ready;
  const cancellation=new AbortController(),second=admission.admit(f.binding,cancellation.signal);cancellation.abort();
  const cancelled=await Promise.race([second.then(()=>false,()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),30))]);release();await first;await second.catch(()=>{});
  assert.equal(cancelled,true,"a same-binding waiter must respect its own abort signal");
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("admission cache has a hard retained-entry cap without invalidating reusable candidates",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const {CandidateAdmissionTransientError}=await import("../packages/contracts/src/verification.js");
  const admission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const initial=await admission.admit(f.binding);
  for(let i=0;i<16;i++)await mkdir(path.join(f.admissions,`retained-${i}`),{mode:0o700});
  assert.equal((await admission.admit(f.binding)).receipt.admissionDigest,initial.receipt.admissionDigest);
  const next=retain(f,f.values.get(f.bundleKey)!,{sliceId:"next"});
  await assert.rejects(admission.admit(next),CandidateAdmissionTransientError);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("candidate facades share verifier capacity and cannot retarget a prepared source",async()=>{
 const f=await fixture();try {
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const {AdmittingVerificationRunner}=await import("../packages/verification/src/admitting-runner.js");
  const {DurableArtifactStore}=await import("../packages/verification/src/artifact-store.js");
  const {getCheckPolicy,getCheckAttemptLifetimeMs}=await import("../packages/verification/src/policy.js");
  let release!:()=>void,started!:()=>void,launches=0;const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
  const imageDigest="a".repeat(64),image=`sha256:${imageDigest}`,policy=getCheckPolicy("node-validate-syntax",image,imageDigest);
  const runner=new AdmittingVerificationRunner({repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:new DurableArtifactStore(path.join(f.root,"verification")),verifierId:"controlled-fixture",image,imageDigest,launcher:{async launch(){launches++;started();await wait;return {sandboxId:"controlled-fixture-only",exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}}},new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts}));
  const a=await runner.forCandidate(f.binding),b=await runner.forCandidate(f.binding),input=await a.prepareBundle(f.binding.repository,f.binding.baseSha,f.binding.candidateSha);
  const requestedAtMs=Date.now(),attemptLifetimeMs=getCheckAttemptLifetimeMs(policy.id);
  const request:import("../packages/contracts/src/verification.js").TrustedCheckRequestV1={version:"orloom.trusted-check-request.v1",attemptId:"11111111-1111-4111-8111-111111111111",missionId:f.binding.missionId,sliceId:f.binding.sliceId,leaseEpoch:f.binding.leaseEpoch,repository:f.binding.repository,candidateSha:f.binding.candidateSha,expectedLocalHeadSha:f.binding.candidateSha,planDigest:f.binding.planDigest,checkId:policy.id,policyVersion:policy.version,policyDigest:policy.digest,verifierImageDigest:imageDigest,inputBundleDigest:input.digest,requestedAt:new Date(requestedAtMs).toISOString(),expiresAt:new Date(requestedAtMs+attemptLifetimeMs).toISOString()};
  await assert.rejects(a.run({...request,leaseEpoch:2},input),/binding/);
  const first=a.run(request,input);await ready;
  let second:import("../packages/contracts/src/verification.js").TrustedCheckReceiptV1;
  try{second=await b.run({...request,attemptId:"22222222-2222-4222-8222-222222222222"},input);}finally{release();}
  assert.equal(second.outcome,"unknown");assert.equal((await first).outcome,"pass");assert.equal(launches,1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("candidate facade rechecks lifecycle after reread before verifier dispatch",async()=>{
 const f=await fixture();try{
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const {AdmittingVerificationRunner}=await import("../packages/verification/src/admitting-runner.js");
  const {DurableArtifactStore}=await import("../packages/verification/src/artifact-store.js");
  const {getCheckPolicy}=await import("../packages/verification/src/policy.js");
  const {LifecycleStoppedError}=await import("../packages/contracts/src/lifecycle.js");
  let admissionReads=0,launches=0;const controller=new AbortController();
  const realAdmission=new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts});
  const admitted=await realAdmission.admit(f.binding);
  const racedAdmission={async admit(){admissionReads++;if(admissionReads===3)controller.abort();return admitted;}} as unknown as InstanceType<typeof CandidateAdmission>;
  const imageDigest="a".repeat(64),image=`sha256:${imageDigest}`,policy=getCheckPolicy("node-validate-syntax",image,imageDigest);
  const facade=await new AdmittingVerificationRunner({repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:new DurableArtifactStore(path.join(f.root,"lifecycle-verification")),verifierId:"controlled-fixture",image,imageDigest,launcher:{async launch(){launches++;return{sandboxId:"fixture",exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}}},racedAdmission).forCandidate(f.binding);
  const input=await facade.prepareBundle(f.binding.repository,f.binding.baseSha,f.binding.candidateSha);
  const request:import("../packages/contracts/src/verification.js").TrustedCheckRequestV1={version:"orloom.trusted-check-request.v1",attemptId:"33333333-3333-4333-8333-333333333333",missionId:f.binding.missionId,sliceId:f.binding.sliceId,leaseEpoch:f.binding.leaseEpoch,repository:f.binding.repository,candidateSha:f.binding.candidateSha,expectedLocalHeadSha:f.binding.candidateSha,planDigest:f.binding.planDigest,checkId:policy.id,policyVersion:policy.version,policyDigest:policy.digest,verifierImageDigest:imageDigest,inputBundleDigest:input.digest,requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()};
  const guard=async()=>{if(controller.signal.aborted)throw new LifecycleStoppedError();};
  const run=facade.run as unknown as (req:typeof request,bundle:typeof input,guard?:()=>Promise<void>)=>Promise<unknown>;
  await assert.rejects(run(request,input,guard),LifecycleStoppedError);
  assert.equal(admissionReads,3,"the abort occurs during the awaited request-time candidate reread");
  assert.equal(launches,0,"the trusted verifier is never dispatched after the reread observes interruption");
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("trusted verifier checks lifecycle at the actual sandbox dispatch boundary",async()=>{
 const f=await fixture();try{
  const {CandidateAdmission}=await import("../packages/verification/src/candidate-admission.js");
  const {AdmittingVerificationRunner}=await import("../packages/verification/src/admitting-runner.js");
  const {DurableArtifactStore}=await import("../packages/verification/src/artifact-store.js");
  const {getCheckPolicy}=await import("../packages/verification/src/policy.js");
  const {LifecycleStoppedError}=await import("../packages/contracts/src/lifecycle.js");
  let launches=0,guardCalls=0;
  const imageDigest="a".repeat(64),image=`sha256:${imageDigest}`,policy=getCheckPolicy("node-validate-syntax",image,imageDigest);
  const facade=await new AdmittingVerificationRunner({repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:new DurableArtifactStore(path.join(f.root,"dispatch-boundary-verification")),verifierId:"controlled-fixture",image,imageDigest,launcher:{async launch(){launches++;return{sandboxId:"fixture",exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}}},new CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}},artifacts:f.artifacts})).forCandidate(f.binding);
  const input=await facade.prepareBundle(f.binding.repository,f.binding.baseSha,f.binding.candidateSha);
  const request:import("../packages/contracts/src/verification.js").TrustedCheckRequestV1={version:"orloom.trusted-check-request.v1",attemptId:"44444444-4444-4444-8444-444444444444",missionId:f.binding.missionId,sliceId:f.binding.sliceId,leaseEpoch:f.binding.leaseEpoch,repository:f.binding.repository,candidateSha:f.binding.candidateSha,expectedLocalHeadSha:f.binding.candidateSha,planDigest:f.binding.planDigest,checkId:policy.id,policyVersion:policy.version,policyDigest:policy.digest,verifierImageDigest:imageDigest,inputBundleDigest:input.digest,requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()};
  const guard=async()=>{guardCalls++;if(guardCalls===3)throw new LifecycleStoppedError("stopped immediately before sandbox dispatch");};
  const run=facade.run as unknown as (req:typeof request,bundle:typeof input,guard?:()=>Promise<void>)=>Promise<unknown>;
  await assert.rejects(run(request,input,guard),LifecycleStoppedError);
  assert.equal(guardCalls,3,"candidate reread and facade validation complete before the runner's dispatch fence");
  assert.equal(launches,0,"no sandbox starts after the final lifecycle checkpoint stops");
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("operator execution profile admits source while preserving full historical Git objects",async()=>{
 const f=await fixture();try {
  await git(f.work,"reset","--hard",f.binding.baseSha);
  await git(f.work,"mv","src","packages");
  await mkdir(path.join(f.work,"docs/evidence"),{recursive:true});
  for(let i=0;i<5;i++)await writeFile(path.join(f.work,`docs/evidence/${i}.log`),Buffer.alloc(3_500_000,65));
  await git(f.work,"add",".");await git(f.work,"commit","-m","historical base");
  f.binding.baseSha=await git(f.work,"rev-parse","HEAD");await git(f.work,"push",f.trusted,"HEAD:main");
  await writeFile(path.join(f.work,"packages/a.js"),"export const a=3;\n");await git(f.work,"commit","-am","real candidate");
  const candidate=await repack(f),binding=retain(f,candidate.bytes,{candidateSha:candidate.candidateSha,scopes:["packages/**"]});
  const api=await import("../packages/verification/src/candidate-admission.js");
  const config={objectStore:f.trusted,approvedRef:"refs/heads/main",executionInputProfile:"orloom-execution-v1" as const};
  const admission=new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":config},artifacts:f.artifacts});
  const admitted=await admission.admit(binding);
  assert.deepEqual([...admitted.input.files.keys()],["packages/a.js"]);
  const manifest=JSON.parse(admitted.input.manifest.toString());
  assert.equal(manifest.executionProfile,"orloom-execution-v1");assert.equal(manifest.treeSha,admitted.receipt.treeSha);
  assert.equal(manifest.excludedFiles,5);assert.equal(manifest.excludedBytes,17_500_000);
  assert.equal(await git(admitted.repository.objectStore,"cat-file","-s",`${candidate.candidateSha}:docs/evidence/0.log`),"3500000");
  assert.equal((await admission.admit(binding)).input.digest,admitted.input.digest);
  const full=new api.CandidateAdmission({...optionsForFull(f),artifacts:f.artifacts});
  await assert.rejects(full.admit(binding),/input bounds|input cap/);
  await assert.rejects(new api.CandidateAdmission({root:f.admissions,repositories:{"owner/repo":{...config,executionInputProfile:"unknown"} as any},artifacts:f.artifacts}).admit(binding),/unknown execution input profile/);
  await writeFile(path.join(f.work,"docs/evidence/changed.log"),"scope violation");await git(f.work,"add",".");await git(f.work,"commit","--amend","--no-edit");
  const outside=await repack(f);await assert.rejects(admission.admit(retain(f,outside.bytes,{candidateSha:outside.candidateSha})),/scope/);
  await git(f.work,"reset","--hard",candidate.candidateSha);
  const blob=await git(f.work,"rev-parse",`${candidate.candidateSha}:packages/a.js`);
  await git(f.work,"update-index","--add","--cacheinfo","120000",blob,"docs/evidence/link");await git(f.work,"commit","--amend","--no-edit");
  const linked=await repack(f);await assert.rejects(admission.admit(retain(f,linked.bytes,{candidateSha:linked.candidateSha,scopes:["**"]})),/symlink|unsupported/);
  await git(f.work,"reset","--hard",candidate.candidateSha);
  for(let i=0;i<5;i++)await writeFile(path.join(f.work,`packages/large-${i}.ts`),Buffer.alloc(3_500_000,65));
  await git(f.work,"add",".");await git(f.work,"commit","--amend","--no-edit");
  const oversized=await repack(f);await assert.rejects(admission.admit(retain(f,oversized.bytes,{candidateSha:oversized.candidateSha,scopes:["packages/**"]})),/input bounds|input cap/);
  await git(f.work,"reset","--hard",candidate.candidateSha);

  await writeFile(path.join(f.work,"unclassified.ts"),"required new root");await git(f.work,"add",".");await git(f.work,"commit","--amend","--no-edit");
  const unknown=await repack(f);
  await assert.rejects(admission.admit(retain(f,unknown.bytes,{candidateSha:unknown.candidateSha,scopes:["**"]})),/unclassified/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

function optionsForFull(f:Awaited<ReturnType<typeof fixture>>) {return {root:f.admissions,repositories:{"owner/repo":{objectStore:f.trusted,approvedRef:"refs/heads/main"}}};}
