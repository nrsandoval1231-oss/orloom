import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, readdir, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MissionConflictError } from "../../contracts/src/mission.js";

const run = promisify(execFile);
const sha1 = /^[a-f0-9]{40}$/;
const safePath=(p:string)=>p.length>0&&!p.startsWith("/")&&!p.includes("\\")&&!/[\x00-\x1f]/.test(p)&&!p.split("/").some(x=>!x||x==="."||x===".."||/^\.git$/i.test(x))&&!/[?*[{\]}]/.test(p);
export function gitAskpassCommand(helper:string){
  if(!helper||/[\x00-\x1f]/.test(helper))throw new MissionConflictError("Installed Git askpass path is unsafe");
  return helper;
}
export interface LocalIntegrationRequest { expectedRefSha:string; candidateSha:string; scopes:string[]; }
export interface RemoteUploadRequest { branch:string; candidateSha:string; protectedRefs:string[]; token:string; }
export interface LocalIntegrationResult { ref:string; previousSha:string; candidateSha:string; treeSha:string; changedPaths:string[]; }
export interface LocalIntegrator { readonly repositoryIdentity:string; inspect(request:LocalIntegrationRequest):Promise<LocalIntegrationResult>; compareAndSwap(request:LocalIntegrationRequest):Promise<LocalIntegrationResult>; readRef():Promise<string>; uploadRef?(request:RemoteUploadRequest):Promise<void>; }

/** Fixed-ref plumbing-only integration over a complete bare object store. It never checks out or executes candidate code. */
export class BareGitFastForwardIntegrator implements LocalIntegrator {
  readonly ref="refs/heads/orloom-integration";
  private constructor(private readonly repository:string,readonly repositoryIdentity:string,private readonly testRemoteUrl?:string){}
  static async open(repository:string,repositoryIdentity:string){return this.create(repository,repositoryIdentity);}
  static async openWithTestRemote(repository:string,repositoryIdentity:string,testRemoteUrl:string){
    if(!testRemoteUrl.startsWith("file:"))throw new MissionConflictError("Test upload transport must be a local bare-repository URL");
    return this.create(repository,repositoryIdentity,testRemoteUrl);
  }
  private static async create(repository:string,repositoryIdentity:string,testRemoteUrl?:string){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryIdentity))throw new MissionConflictError("A fixed trusted owner/repository identity is required");
    const requested=resolve(repository),requestedInfo=await lstat(requested);if(requestedInfo.isSymbolicLink())throw new MissionConflictError("Local integration repository path cannot be a symlink");
    const path=await realpath(requested); const info=await stat(path);
    if(!info.isDirectory())throw new MissionConflictError("Local integration object store must be a directory");
    const g=new BareGitFastForwardIntegrator(path,repositoryIdentity.toLowerCase(),testRemoteUrl);
    await g.assertCompleteStore();
    return g;
  }
  private async git(args:string[]){const disabled=process.platform==="win32"?"NUL":"/dev/null";const x=await run("git",["-c",`core.hooksPath=${disabled}`,"-c",`core.attributesFile=${disabled}`,"-c","core.fsmonitor=false","-c","diff.external=","-c","submodule.recurse=false","--no-pager","-C",this.repository,...args],{encoding:"buffer",maxBuffer:8*1024*1024,timeout:15_000,windowsHide:true,env:{PATH:process.env.PATH??"",HOME:process.env.HOME??process.env.USERPROFILE??"",USERPROFILE:process.env.USERPROFILE??"",SystemRoot:process.env.SystemRoot??"",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_NO_REPLACE_OBJECTS:"1"}});return x.stdout.toString("utf8");}
  private async assertCompleteStore(){
    const root=await lstat(this.repository);if(root.isSymbolicLink()||!root.isDirectory()||(await realpath(this.repository))!==this.repository)throw new MissionConflictError("Local integration repository path changed or is unsafe");
    for(const relative of ["objects","objects/info","refs","refs/heads"]){const child=await lstat(join(this.repository,relative));if(child.isSymbolicLink()||!child.isDirectory())throw new MissionConflictError("Git objects, info, and refs must be real repository-local directories");}
    const configPath=join(this.repository,"config"),configInfo=await lstat(configPath);if(configInfo.isSymbolicLink()||!configInfo.isFile()||configInfo.size>1024*1024)throw new MissionConflictError("Bare Git configuration must be a bounded repository-local regular file");
    const rawConfig=await readFile(configPath,"utf8");if(/^\s*\[\s*include(?:if)?\b/im.test(rawConfig))throw new MissionConflictError("Git configuration includes are not accepted");
    try{await lstat(join(this.repository,"objects","info","alternates"));throw new MissionConflictError("External Git object alternates are not accepted");}catch(error){if(error instanceof MissionConflictError)throw error;if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new MissionConflictError("Git alternates could not be safely checked");}
    try{const ref=await lstat(join(this.repository,this.ref));if(ref.isSymbolicLink()||!ref.isFile())throw new MissionConflictError("Integration ref must be a repository-local regular file");}catch(error){if(error instanceof MissionConflictError)throw error;if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new MissionConflictError("Integration ref could not be safely checked");}
    if((await this.git(["rev-parse","--is-bare-repository"])).trim()!=="true")throw new MissionConflictError("Local integration requires a bare Git repository");
    const shallow=(await this.git(["rev-parse","--is-shallow-repository"])).trim(),config=(await this.git(["config","--local","--no-includes","--list","--null"])).split("\0").filter(Boolean).map(x=>{const [key,value=""]=x.split("\n",2);return{key:key!.toLowerCase(),value};});
    const allowed=(key:string)=>["core.repositoryformatversion","core.filemode","core.bare","core.logallrefupdates","core.ignorecase","core.symlinks","core.precomposeunicode","extensions.objectformat"].includes(key)||/^remote\..+\.(?:url|fetch)$/.test(key);
    if(shallow!=="false"||config.some(x=>!allowed(x.key)||x.key.endsWith(".url")&&/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(x.value)))throw new MissionConflictError("Bare Git configuration contains unsupported transport, credential, hook, filter, include, or object-store settings");
    const hooks=join(this.repository,"hooks");try{const hs=await lstat(hooks);if(hs.isSymbolicLink()||!hs.isDirectory())throw new MissionConflictError("Unsafe Git hooks directory");const active=(await readdir(hooks)).filter(x=>!x.endsWith(".sample"));if(active.length)throw new MissionConflictError("Active Git hooks are not accepted for local integration");}catch(error){if(error instanceof MissionConflictError)throw error;if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new MissionConflictError("Git hooks could not be safely checked");}
  }
  async readRef(){const value=(await this.git(["rev-parse","--verify",this.ref])).trim();if(!sha1.test(value))throw new MissionConflictError("Integration ref is unavailable or malformed");return value;}
  async uploadRef(request:RemoteUploadRequest):Promise<void>{
    try{
      if(typeof request.token!=="string"||!request.token||request.token.length>4096||/[\r\n\x00]/.test(request.token)||!sha1.test(request.candidateSha)||!/^orloom\/delivery\/[0-9a-f-]{36}\/[a-f0-9]{12}$/.test(request.branch)||request.protectedRefs.some(ref=>ref===request.branch||ref===`refs/heads/${request.branch}`)||request.branch==="orloom/delivery/main")throw new Error();
      const productionUrl=`https://github.com/${this.repositoryIdentity}.git`;
      const url=this.testRemoteUrl??productionUrl;
      await this.assertCompleteStore();
      if(await this.readRef()!==request.candidateSha)throw new Error();
      const tree=(await this.git(["rev-parse",`${request.candidateSha}^{tree}`])).trim();if(!sha1.test(tree))throw new Error();
      const helper=fileURLToPath(new URL(process.platform==="win32"?"./git-askpass.cmd":"./git-askpass.sh",import.meta.url));
      const helperInfo=await lstat(helper);if(helperInfo.isSymbolicLink()||!helperInfo.isFile())throw new Error();
      const askpass=gitAskpassCommand(helper);
      const env:NodeJS.ProcessEnv={PATH:process.env.PATH??"",SystemRoot:process.env.SystemRoot??"",ComSpec:process.env.ComSpec??"",HOME:process.env.HOME??process.env.USERPROFILE??"",USERPROFILE:process.env.USERPROFILE??"",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_NO_REPLACE_OBJECTS:"1",GIT_ASKPASS:askpass,ORLOOM_GIT_UPLOAD_TOKEN:request.token,GIT_TRACE:"0",GIT_TRACE_PACKET:"0",GIT_TRACE_CURL:"0",GIT_TRACE2:"0",GIT_CURL_VERBOSE:"0",GIT_EXEC_PATH:"",GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"credential.helper",GIT_CONFIG_VALUE_0:""};
      const disabled=process.platform==="win32"?"NUL":"/dev/null";
      await run("git",["-c",`core.hooksPath=${disabled}`,"-c","core.fsmonitor=false","--no-pager","-C",this.repository,"push","--no-verify",url,`${request.candidateSha}:refs/heads/${request.branch}`],{encoding:"buffer",maxBuffer:64*1024,timeout:60_000,windowsHide:true,env});
    }catch{throw new MissionConflictError("Remote upload transport failed; outcome requires exact remote reconciliation");}
  }
  async inspect(request:LocalIntegrationRequest):Promise<LocalIntegrationResult>{
    const overlap=request.scopes.some((a,i)=>request.scopes.some((b,j)=>i!==j&&(a.startsWith(`${b}/`)||b.startsWith(`${a}/`))));
    if(!sha1.test(request.expectedRefSha)||!sha1.test(request.candidateSha)||!request.scopes.length||request.scopes.some(p=>!safePath(p))||new Set(request.scopes.map(p=>p.toLowerCase())).size!==request.scopes.length||overlap)throw new MissionConflictError("Integration SHA, unsafe path, or overlapping scope is invalid");
    await this.assertCompleteStore();
    const current=await this.readRef();if(current!==request.expectedRefSha&&current!==request.candidateSha)throw new MissionConflictError("Integration ref moved before compare-and-swap or recovery");
    const parents=(await this.git(["rev-list","--parents","--reverse",`${request.expectedRefSha}..${request.candidateSha}`])).trim().split(/\r?\n/).filter(Boolean);
    if(parents.length!==1||parents[0]!==`${request.candidateSha} ${request.expectedRefSha}`)throw new MissionConflictError("Candidate must be the reviewed direct child of the current integration head");
    const entries=(sha:string)=>this.git(["ls-tree","-rz","--full-tree",sha]).then(raw=>raw.split("\0").filter(Boolean).map(item=>{const i=item.indexOf("\t"),head=item.slice(0,i).split(" "),path=item.slice(i+1);return{mode:head[0]!,type:head[1]!,path};}));
    const [before,after]=await Promise.all([entries(request.expectedRefSha),entries(request.candidateSha)]);
    const validate=(rows:{mode:string;type:string;path:string}[])=>{const names=new Set<string>();for(const row of rows){const fold=row.path.toLocaleLowerCase("en-US");if(!safePath(row.path)||names.has(fold)||row.type!=="blob"||!(["100644","100755"].includes(row.mode)))throw new MissionConflictError("Candidate contains unsafe, colliding, symlink, or gitlink paths");names.add(fold);}return names;};
    const beforeNames=validate(before),afterNames=validate(after);const changed=(await this.git(["diff-tree","--no-ext-diff","--no-textconv","--no-commit-id","--name-only","-r","-z",request.expectedRefSha,request.candidateSha])).split("\0").filter(Boolean).sort();
    const inScope=(path:string)=>request.scopes.some(scope=>{const s=scope.replace(/\/$/,"");if(/[?*[{]/.test(s))return false;return path===s||path.startsWith(`${s}/`);});
    if(changed.some(path=>!inScope(path)))throw new MissionConflictError("Candidate changes files outside the approved slice scopes");
    const treeSha=(await this.git(["rev-parse",`${request.candidateSha}^{tree}`])).trim();if(!sha1.test(treeSha))throw new MissionConflictError("Candidate tree identity is invalid");
    return{ref:this.ref,previousSha:current,candidateSha:request.candidateSha,treeSha,changedPaths:changed};
  }
  async compareAndSwap(request:LocalIntegrationRequest){const inspected=await this.inspect(request);const current=await this.readRef();if(current===request.candidateSha)return inspected;await this.assertCompleteStore();try{await this.git(["update-ref",this.ref,request.candidateSha,request.expectedRefSha]);}catch{throw new MissionConflictError("Integration ref compare-and-swap failed; reconcile the durable intent before retrying");}const observed=await this.readRef();if(observed!==request.candidateSha)throw new MissionConflictError("Integration ref write outcome is ambiguous");return inspected;}
}
