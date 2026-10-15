import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CandidateAdmissionTransientError, CandidateArtifactInvalidError, type CandidateAdmissionBindingV1 } from "../../contracts/src/verification.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { assertWorkerScopePath } from "../../agents/src/worker.js";
import { extractCandidateBundle, readApprovedHead, type InputBundle, type RepositoryConfig, type RepositoryGit } from "./repository.js";

export interface BoundedCandidateArtifacts { getBounded(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>; }
export interface CandidateAdmissionOptions { root: string; repositories: Readonly<Record<string, RepositoryConfig>>; artifacts: BoundedCandidateArtifacts; }
export interface AdmissionReceipt {
  version: "orloom.candidate-admission-receipt.v1"; admissionDigest: string;
  binding: CandidateAdmissionBindingV1; candidateSha: string; treeSha: string;
  bundleDigest: string; indexDigest: string; inputManifestDigest: string;
}
export interface AdmittedCandidate { repository: RepositoryConfig; input: InputBundle; receipt: AdmissionReceipt; }
export const CANDIDATE_ADMISSION_LIMITS=Object.freeze({bundleBytes:20_000_000,indexBytes:256_000,packObjects:12_000,gitOutputBytes:24_000_000,deadlineMs:90_000,commandMs:10_000,retainedEntries:16});
const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const sha1=(x:unknown):x is string=>typeof x==="string"&&/^[a-f0-9]{40}$/.test(x);
const sha256=(x:unknown):x is string=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const approvedRef="refs/heads/admitted-candidate";
let activeAdmissions=0;
const admissionWaiters:Array<{signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;abort:()=>void}>=[];
function releaseAdmission():void {
  activeAdmissions--;
  const next=admissionWaiters.shift();
  if(next){next.signal.removeEventListener("abort",next.abort);activeAdmissions++;next.resolve(releaseAdmission);}
}
async function acquireAdmission(signal:AbortSignal):Promise<()=>void> {
  if(signal.aborted)throw new CandidateAdmissionTransientError("Admission cancelled while waiting");
  if(activeAdmissions<1){activeAdmissions++;return releaseAdmission;}
  if(admissionWaiters.length>=6)throw new CandidateAdmissionTransientError("Admission queue capacity is occupied");
  return new Promise((resolve,reject)=>{
    const waiter={signal,resolve,reject,abort:()=>{const at=admissionWaiters.indexOf(waiter);if(at>=0)admissionWaiters.splice(at,1);reject(new CandidateAdmissionTransientError("Admission cancelled while waiting"));}};
    admissionWaiters.push(waiter);signal.addEventListener("abort",waiter.abort,{once:true});
  });
}
const failure=(message:string)=>new Error(`Candidate admission refused: ${message}`);

/** No shell, fetch, checkout, credentials, replacement objects, hooks or network
 * protocols. Limits apply only to this child; no host policy is modified. */
async function boundedGit(repo:string,args:string[],maxBuffer:number=CANDIDATE_ADMISSION_LIMITS.gitOutputBytes,input?:Uint8Array,deadline=Date.now()+CANDIDATE_ADMISSION_LIMITS.deadlineMs,signal?:AbortSignal):Promise<Buffer> {
  signal?.throwIfAborted();
  if(process.platform!=="linux")throw failure("bounded Linux Git importer is unavailable");
  const timeout=Math.min(CANDIDATE_ADMISSION_LIMITS.commandMs,deadline-Date.now());
  if(timeout<=0)throw failure("admission deadline expired");
  return new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/prlimit",["--as=536870912","--cpu=10","--fsize=33554432","--","/usr/bin/git","--git-dir",repo,
      "-c","core.hooksPath=/dev/null","-c","core.attributesFile=/dev/null","-c","core.fsmonitor=false","-c","protocol.allow=never","-c","submodule.recurse=false","-c","pack.threads=1","-c","diff.external=",...args],
      {detached:true,stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent",LANG:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_NO_REPLACE_OBJECTS:"1"}});
    const output:Buffer[]=[];let size=0,errorBytes=0,failed=false;
    const kill=()=>{if(child.pid){try{process.kill(-child.pid,"SIGKILL");}catch{child.kill("SIGKILL");}}};
    const interrupt=()=>{failed=true;kill();};
    const timer=setTimeout(interrupt,timeout);
    signal?.addEventListener("abort",interrupt,{once:true});
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",interrupt);};
    child.stdout.on("data",(part:Buffer)=>{size+=part.length;if(size>maxBuffer){failed=true;kill();}else output.push(part);});
    child.stderr.on("data",(part:Buffer)=>{errorBytes+=part.length;if(errorBytes>65536){failed=true;kill();}});
    child.stdin.on("error",()=>{ /* close result is authoritative; no retry */ });
    child.once("error",()=>{cleanup();reject(failure("bounded Git process unavailable"));});
    child.once("close",code=>{cleanup();if(failed||code!==0)reject(failure("bounded Git operation failed or exceeded limits"));else resolve(Buffer.concat(output));});
    if(signal?.aborted)interrupt();
    child.stdin.end(input);
  });
}

export function admissionGitReader(deadline=Date.now()+CANDIDATE_ADMISSION_LIMITS.deadlineMs):RepositoryGit {return (repo,args,max)=>boundedGit(repo,args,max,undefined,deadline);}

async function privateDirectory(root:string):Promise<void> {
  if(!path.isAbsolute(root)||path.resolve(root)===path.parse(root).root)throw failure("private absolute root required");
  const info=await lstat(root);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(typeof process.getuid==="function"&&info.uid!==process.getuid())||await realpath(root)!==path.resolve(root))throw failure("admission root must be a private owned real directory");
}
function bundlePack(bytes:Uint8Array,candidate:string,base:string):Buffer {
  const data=Buffer.from(bytes),end=data.indexOf("\n\n");
  if(end<0||end>16_384)throw failure("invalid or oversized bundle header");
  const header=data.subarray(0,end).toString("ascii").split("\n");
  if(header.shift()!=="# v2 git bundle")throw failure("only the reviewed v2 bundle envelope is accepted");
  const prerequisites=header.filter(x=>x.startsWith("-")),heads=header.filter(x=>!x.startsWith("-"));
  if(prerequisites.length!==1||!new RegExp(`^-${base}(?: [^\\x00-\\x1f]{0,1000})?$`).test(prerequisites[0]!)||heads.length!==1||heads[0]!==`${candidate} refs/heads/orloom-candidate`)throw failure("bundle is not bound to the exact candidate and base");
  const pack=data.subarray(end+2);
  if(pack.length<32||pack.subarray(0,4).toString("ascii")!=="PACK"||pack.readUInt32BE(4)!==2||pack.readUInt32BE(8)>CANDIDATE_ADMISSION_LIMITS.packObjects)throw failure("invalid or oversized Git pack");
  return pack;
}
function bindingKey(binding:CandidateAdmissionBindingV1):string {
  if(binding.version!=="orloom.candidate-admission.v1"||!/^[-a-zA-Z0-9_]{1,64}$/.test(binding.missionId)||!/^[-a-zA-Z0-9_]{1,64}$/.test(binding.sliceId)||!Number.isSafeInteger(binding.leaseEpoch)||binding.leaseEpoch<1
    ||! /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(binding.repository)||!sha1(binding.baseSha)||!sha1(binding.candidateSha)||!sha256(binding.planDigest)||!sha256(binding.trustedCheckPolicyDigest)
    ||!Array.isArray(binding.scopes)||!binding.scopes.length||binding.scopes.length>128||binding.scopes.some(x=>typeof x!=="string"||x.length>1000)
    ||!Array.isArray(binding.evidenceRefs)||binding.evidenceRefs.length>100||binding.evidenceRefs.some(x=>typeof x!=="string"||x.length>2048))throw failure("invalid controller binding");
  return hash(canonicalJson(binding));
}
function evidenceKey(binding:CandidateAdmissionBindingV1,name:string):string {
  const rows=binding.evidenceRefs.filter(x=>x.startsWith(`${name}:`));
  if(rows.length!==1||!new RegExp(`^${name}:sha256/[a-f0-9]{64}$`).test(rows[0]!))throw failure(`exactly one ${name} digest is required`);
  return rows[0]!.slice(name.length+1);
}
export class CandidateAdmission {
  constructor(private readonly options:CandidateAdmissionOptions) {}
  async admit(input:CandidateAdmissionBindingV1,signal?:AbortSignal):Promise<AdmittedCandidate> {
    signal?.throwIfAborted();
    const binding=structuredClone(input),key=bindingKey(binding);
    const cancellation=new AbortController(),deadline=Date.now()+CANDIDATE_ADMISSION_LIMITS.deadlineMs;
    const abort=()=>cancellation.abort(signal?.reason);
    signal?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(()=>cancellation.abort(failure("whole-admission deadline expired")),CANDIDATE_ADMISSION_LIMITS.deadlineMs);
    const task=(async()=>{const release=await acquireAdmission(cancellation.signal);try{return await this.perform(binding,key,deadline,cancellation.signal);}catch(error){if(cancellation.signal.aborted)throw new CandidateAdmissionTransientError("Admission cancelled or deadline expired");throw error;}finally{release();}})();
    try{return await task;}finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);cancellation.abort();}
  }
  private async read(key:string,max:number,signal:AbortSignal):Promise<Buffer> {
    signal.throwIfAborted();
    let abort!:()=>void;
    const timeout=new Promise<never>((_resolve,reject)=>{abort=()=>reject(failure("artifact read deadline expired"));signal.addEventListener("abort",abort,{once:true});});
    let bytes:Buffer;
    try{bytes=Buffer.from(await Promise.race([this.options.artifacts.getBounded(key,max,signal),timeout]));}
    catch(error){if(error instanceof CandidateArtifactInvalidError)throw error;throw new CandidateAdmissionTransientError("Candidate artifact transport is unavailable");}
    finally{signal.removeEventListener("abort",abort);}
    signal.throwIfAborted();
    if(bytes.length>max||hash(bytes)!==key.slice(7))throw failure("artifact digest or byte limit mismatch");
    return bytes;
  }
  private async perform(binding:CandidateAdmissionBindingV1,key:string,deadline:number,signal:AbortSignal):Promise<AdmittedCandidate> {
    await privateDirectory(this.options.root);
    if(!Object.hasOwn(this.options.repositories,binding.repository))throw failure("repository is not operator approved");
    const trusted=this.options.repositories[binding.repository]!;
    const run:RepositoryGit=(repo,args,max)=>boundedGit(repo,args,max,undefined,deadline,signal);
    const bundleKey=evidenceKey(binding,"candidate-bundle"),indexKey=evidenceKey(binding,"evidence-index");
    const index=JSON.parse((await this.read(indexKey,CANDIDATE_ADMISSION_LIMITS.indexBytes,signal)).toString("utf8")) as Record<string,unknown>;
    if(index.version!=="orloom.worker-evidence-index.v1"||index.missionId!==binding.missionId||index.sliceId!==binding.sliceId||index.leaseEpoch!==binding.leaseEpoch||index.baseSha!==binding.baseSha||index.planDigest!==binding.planDigest||index.trustedCheckPolicyDigest!==binding.trustedCheckPolicyDigest||!Array.isArray(index.entries)||index.entries.length>2000)throw failure("evidence index does not match the controller binding");
    const entries=index.entries.filter((x:unknown)=>x&&typeof x==="object"&&(x as Record<string,unknown>).name==="candidate-bundle") as Record<string,unknown>[];
    if(entries.length!==1||entries[0]!.key!==bundleKey||entries[0]!.sha256!==bundleKey.slice(7)||entries[0]!.reference!==`candidate-bundle:${bundleKey}`)throw failure("candidate bundle is not bound by the evidence index");
    const bytes=await this.read(bundleKey,CANDIDATE_ADMISSION_LIMITS.bundleBytes,signal),pack=bundlePack(bytes,binding.candidateSha,binding.baseSha);
    // Validate trusted base locally; never fetch missing objects or accept alternates.
    await assertNoGrafts(trusted.objectStore);
    await extractCandidateBundle(trusted,binding.baseSha,binding.baseSha,run);
    const destination=path.join(this.options.root,key);
    try {await lstat(destination);return await this.readAdmission(destination,binding,key,bundleKey,indexKey,run);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    // The operator owns this private root exclusively in one controller process.
    // Never evict evidence automatically. Count all entries, including interrupted
    // staging directories, so failed cleanup cannot grow retention without bound.
    let retained=0;
    for await(const _entry of await opendir(this.options.root)) {
      if(++retained>=CANDIDATE_ADMISSION_LIMITS.retainedEntries)throw new CandidateAdmissionTransientError("Admission cache capacity is occupied; operator retention review required");
    }
    const staging=await mkdtemp(path.join(this.options.root,"pending-"));
    try {
      const objects=path.join(staging,"objects.git");
      // Git preserves the mode of a pre-created bare repository directory;
      // mkdtemp's private parent alone does not make objects.git private.
      await mkdir(objects,{mode:0o700});
      await boundedGit(objects,["init","--bare","--template="],65536,undefined,deadline,signal);
      const basePack=await boundedGit(trusted.objectStore,["pack-objects","--stdout","--revs","--window=0","--depth=0"],CANDIDATE_ADMISSION_LIMITS.bundleBytes,Buffer.from(`${binding.baseSha}\n`),deadline,signal);
      await boundedGit(objects,["index-pack","--stdin","--max-input-size=20000000","--threads=1"],65536,basePack,deadline,signal);
      await boundedGit(objects,["index-pack","--stdin","--fix-thin","--max-input-size=20000000","--threads=1"],65536,pack,deadline,signal);
      const parents=(await run(objects,["rev-list","--parents","-n","1",binding.candidateSha],1024)).toString("ascii").trim();
      if(parents!==`${binding.candidateSha} ${binding.baseSha}`)throw failure("candidate must be one direct child of the approved base");
      await run(objects,["update-ref",approvedRef,binding.candidateSha,"0000000000000000000000000000000000000000"],65536);
      // Git follows the process umask for these files. The enclosing admission
      // root is private, and these persisted identities must also remain private.
      await chmod(path.join(objects,"config"),0o600);
      await chmod(path.join(objects,"refs","heads","admitted-candidate"),0o600);
      await run(objects,["fsck","--strict","--full","--no-reflogs","--no-dangling"],65536);
      const config={objectStore:objects,approvedRef},input=await this.inspect(config,binding,run);
      const treeSha=(await run(objects,["rev-parse",`${binding.candidateSha}^{tree}`],1024)).toString("ascii").trim();if(!sha1(treeSha))throw failure("invalid candidate tree");
      const receipt:AdmissionReceipt={version:"orloom.candidate-admission-receipt.v1",admissionDigest:key,binding,candidateSha:binding.candidateSha,treeSha,bundleDigest:bundleKey.slice(7),indexDigest:indexKey.slice(7),inputManifestDigest:input.digest};
      await writeFile(path.join(staging,"receipt.json"),canonicalJson(receipt),{mode:0o600,flag:"wx"});
      await privateDirectory(this.options.root);
      try{await rename(staging,destination);}catch(error){if(!["EEXIST","ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code??""))throw error;}
      return await this.readAdmission(destination,binding,key,bundleKey,indexKey,run);
    }finally{await rm(staging,{recursive:true,force:true});}
  }
  private async inspect(repository:RepositoryConfig,binding:CandidateAdmissionBindingV1,run:RepositoryGit):Promise<InputBundle> {
    await assertNoGrafts(repository.objectStore);
    await run(repository.objectStore,["fsck","--strict","--full","--no-reflogs","--no-dangling"],65536);
    if((await run(repository.objectStore,["rev-list","--parents","-n","1",binding.candidateSha],1024)).toString("ascii").trim()!==`${binding.candidateSha} ${binding.baseSha}`)throw failure("candidate parent identity changed");
    if(await readApprovedHead(repository,run)!==binding.candidateSha)throw failure("admitted head changed");
    const changed=await run(repository.objectStore,["diff-tree","--no-commit-id","--name-only","--no-renames","-r","-z",binding.baseSha,binding.candidateSha],1_000_000);
    let names:string;try{names=new TextDecoder("utf-8",{fatal:true}).decode(changed);}catch{throw failure("invalid path encoding");}
    for(const name of names.split("\0").filter(Boolean))assertWorkerScopePath(name,binding.scopes);
    return extractCandidateBundle(repository,binding.baseSha,binding.candidateSha,run);
  }
  private async readAdmission(directory:string,binding:CandidateAdmissionBindingV1,key:string,bundleKey:string,indexKey:string,run:RepositoryGit):Promise<AdmittedCandidate> {
    await privateDirectory(directory);
    const file=path.join(directory,"receipt.json"),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>256000||(info.mode&0o077)!==0)throw failure("unsafe admission receipt");
    const receipt=JSON.parse(await readFile(file,"utf8")) as AdmissionReceipt;
    if(receipt.version!=="orloom.candidate-admission-receipt.v1"||receipt.admissionDigest!==key||canonicalJson(receipt.binding)!==canonicalJson(binding)||receipt.candidateSha!==binding.candidateSha||receipt.bundleDigest!==bundleKey.slice(7)||receipt.indexDigest!==indexKey.slice(7))throw failure("admission receipt binding changed");
    const objectStore=path.join(directory,"objects.git");if((await lstat(objectStore)).isSymbolicLink()||await realpath(objectStore)!==objectStore)throw failure("admission object store escaped confinement");
    const repository={objectStore,approvedRef},input=await this.inspect(repository,binding,run);
    const treeSha=(await run(objectStore,["rev-parse",`${binding.candidateSha}^{tree}`],1024)).toString("ascii").trim();
    if(input.digest!==receipt.inputManifestDigest||treeSha!==receipt.treeSha)throw failure("admitted source content changed");
    return {repository,input,receipt};
  }
}

async function assertNoGrafts(repo:string):Promise<void> {
  for(const relative of ["info/grafts","objects/info/alternates","shallow"]) {
    try{await lstat(path.join(repo,relative));throw failure("unsafe graft, alternate or shallow boundary");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
}
