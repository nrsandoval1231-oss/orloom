import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here=dirname(fileURLToPath(import.meta.url)),port=15437,bin="C:\\Program Files\\PostgreSQL\\18\\bin";
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1]};
function exec(file,args,{cwd,env,ms=30000,max=1048576,stdioMode="capture",killTree=true}={}) {
 return new Promise((resolveRun,reject)=>{
  const capture=stdioMode==="capture";
  const child=spawn(file,args,{cwd,env,windowsHide:true,stdio:capture?["ignore","pipe","pipe"]:"ignore"});let out="",bytes=0,reason=null,settled=false,killTimer;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);error?reject(error):resolveRun(value)};
  const stop=why=>{if(reason||settled)return;reason=why;if(killTree&&Number.isSafeInteger(child.pid)){const killer=spawn("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.on("error",()=>child.kill());}else child.kill();killTimer=setTimeout(()=>finish(Error("Bounded child termination UNKNOWN")),5000);killTimer.unref();};
  const timer=setTimeout(()=>stop("deadline exceeded"),ms);timer.unref();
  if(capture){
   child.stdout.on("data",b=>{bytes+=b.length;if(bytes>max)stop("output limit");else out+=b.toString()});
   child.stderr.on("data",b=>{bytes+=b.length;if(bytes>max)stop("output limit")});
   child.once("close",code=>finish(reason||code!==0?Error("Bounded child failed: "+(reason??("exit "+code))):null,out.trim()));
  }else child.once("exit",code=>finish(reason||code!==0?Error("Bounded child failed: "+(reason??("exit "+code))):null,""));
  child.once("error",()=>finish(Error("Bounded child could not start")));
 });
}
async function portFree(){await new Promise((ok,no)=>{const s=createServer();s.once("error",no);s.listen(port,"127.0.0.1",()=>s.close(ok))})}
async function portReady(ms=5000){
 const deadline=Date.now()+ms;
 while(Date.now()<deadline){
  const connected=await new Promise(done=>{const socket=createConnection(port,"127.0.0.1");const timer=setTimeout(()=>{socket.destroy();done(false)},300);socket.once("connect",()=>{clearTimeout(timer);socket.destroy();done(true)});socket.once("error",()=>{clearTimeout(timer);socket.destroy();done(false)})});
  if(connected)return;
  await new Promise(done=>setTimeout(done,100));
 }
 throw Error("bounded loopback listener check failed");
}
async function sha(p){return createHash("sha256").update(await readFile(p)).digest("hex")}
async function allJs(root,dir=""){const output=[];for(const e of await readdir(join(root,dir),{withFileTypes:true})){const r=join(dir,e.name);if(e.isDirectory())output.push(...await allJs(root,r));else if(e.isFile()&&e.name.endsWith(".js"))output.push(r)}return output}
async function main(){
 const source=resolve(arg("--source")??""),expected=arg("--expected-sha"),compiled=resolve(arg("--compiled-manifest")??"");
 if(!process.argv.includes("--authorize-local-proof"))throw Error("explicit local-proof authorization required");
 if(!/^[a-f0-9]{40}$/.test(expected??""))throw Error("frozen SHA required");
 const head=await exec("git",["-C",source,"rev-parse","HEAD"]);
 if(head!==expected)throw Error("unexpected source SHA");
 if(await exec("git",["-C",source,"status","--porcelain"]))throw Error("source dirty");
 const dist=join(source,"dist"),compiledManifest=JSON.parse(await readFile(compiled,"utf8"));
 if(compiledManifest.candidateSha!==head||!compiledManifest.files||typeof compiledManifest.files!=="object")throw Error("compiled manifest does not bind candidate");
 const compiledPaths=(await allJs(dist)).map(p=>"dist/"+p.replaceAll("\\","/")).sort();
 if(JSON.stringify(compiledPaths)!==JSON.stringify(Object.keys(compiledManifest.files).sort()))throw Error("Incomplete compiled inventory");
 for(const [r,h] of Object.entries(compiledManifest.files)){if(!r.startsWith("dist/")||r.includes("..")||r.includes("\\")||!/^[a-f0-9]{64}$/.test(h)||await sha(join(source,r))!==h)throw Error("compiled manifest hash mismatch")}
 for(const x of [join(source,"node_modules","pg","package.json"),join(bin,"initdb.exe"),join(bin,"pg_ctl.exe"),join(bin,"postgres.exe")])await access(x);
 await portFree();
 const root=join(here,"runtime",`${Date.now()}-${randomUUID()}`),data=join(root,"cluster"),ev=join(root,"evidence"),pw=join(root,".password");
 await mkdir(ev,{recursive:true});
 const me=await exec("whoami",[]);await exec("icacls",[root,"/inheritance:r","/grant:r",`${me}:(OI)(CI)F`]);
 const log=(n,f={})=>appendFile(join(ev,"runner.jsonl"),JSON.stringify({at:new Date().toISOString(),n,...f})+"\n");
 const owner=randomUUID(),pass=randomBytes(32).toString("base64url");
 let launch=false,pid=null,proofOutcome="FAIL",phase="credential_setup",failure=null;
 const startedUtc=new Date().toISOString();
 try{
  await writeFile(pw,pass,{flag:"wx"});
  phase="initdb";
  await exec(join(bin,"initdb.exe"),["-D",data,"-U","c4proof","-A","scram-sha-256",`--pwfile=${pw}`,"--no-locale","--encoding=UTF8"]);
  await writeFile(join(data,"c4-proof-owner.json"),JSON.stringify({owner,data:resolve(data),port,head}),{flag:"wx"});
  launch=true;
  phase="pg_ctl_start";
  try{await access(join(data,"postmaster.pid"));throw Error("postmaster PID file unexpectedly existed before startup")}catch(error){if(error?.code!=="ENOENT")throw error}
  await exec(join(bin,"pg_ctl.exe"),["-D",data,"-l",join(ev,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1`,"-w","-t","30","start"],{ms:40000,stdioMode:"ignore",killTree:false});
  phase="verify_owned_postmaster";
  const lines=(await readFile(join(data,"postmaster.pid"),"utf8")).split(/\r?\n/);pid=Number(lines[0]);
  if(!Number.isSafeInteger(pid)||pid<=0||resolve(lines[1]).toLowerCase()!==resolve(data).toLowerCase()||lines[3]!==String(port)||lines[5]!=="127.0.0.1")throw Error("fresh postmaster identity mismatch");
  phase="verify_loopback_listener";
  await portReady();
  const cfg=join(root,"connection.json");
  phase="write_connection_config";
  await writeFile(cfg,JSON.stringify({host:"127.0.0.1",port,user:"c4proof",password:pass,database:"postgres",connectionTimeoutMillis:5000,statement_timeout:15000,application_name:"c4-local-proof"}),{flag:"wx"});
  phase="write_preflight";
  const modules=Object.fromEntries(await Promise.all((await allJs(dist)).map(async r=>[r,await sha(join(dist,r))])));
  await writeFile(join(ev,"preflight.json"),JSON.stringify({candidateSha:head,postgresVersion:await exec(join(bin,"postgres.exe"),["--version"]),modules},null,2));
  phase="scenario";
  await exec(process.execPath,[join(here,"scenario.mjs")],{cwd:source,env:{...process.env,C4_PG_RUNTIME:root,C4_PG_CONFIG:cfg,C4_PG_EVIDENCE:ev,C4_PG_SOURCE:source,C4_PG_EXPECTED_SHA:head},ms:240000});
  proofOutcome="PASS_DATABASE_BEHAVIOR_ONLY";await log("scenario_passed",{head});phase="complete";
 }catch(error){
  const message=(error instanceof Error?error.message:"Runner failure").replaceAll(pass,"[REDACTED]").replace(/[\r\n\t]+/g," ").slice(0,300);
  failure={phase,code:String(error?.code??error?.name??"RUNNER_FAILURE").replace(/[^A-Za-z0-9_.-]/g,"_").slice(0,80),message};
  throw error;
 }finally{
  let cleanup="NOT_STARTED";
  if(launch){try{const marker=JSON.parse(await readFile(join(data,"c4-proof-owner.json"),"utf8")),lines=(await readFile(join(data,"postmaster.pid"),"utf8")).split(/\r?\n/),nowPid=Number(lines[0]);if(marker.owner!==owner||marker.data!==resolve(data)||marker.port!==port||!Number.isSafeInteger(nowPid)||(pid!==null&&pid!==nowPid)||resolve(lines[1]).toLowerCase()!==resolve(data).toLowerCase()||lines[3]!==String(port)||lines[5]!=="127.0.0.1")throw Error("owned identity mismatch");await exec(join(bin,"pg_ctl.exe"),["-D",data,"-m","fast","-w","-t","30","stop"],{ms:35000,stdioMode:"ignore",killTree:false});await portFree();cleanup="STOPPED_OWNED_CLUSTER"}catch(error){cleanup=`UNKNOWN:${error instanceof Error?error.message.slice(0,200):"error"}`}}
  await writeFile(join(ev,"manifest.json"),JSON.stringify({candidateSha:head,cleanup,outcome:proofOutcome,failedPhase:failure?.phase??null,failure,startedUtc,finishedUtc:new Date().toISOString(),execution:"EXECUTED",limitations:"Controlled fixtures only."},null,2));
  await log("finished",{cleanup,failedPhase:failure?.phase??null});
  if(cleanup.startsWith("UNKNOWN"))throw Error(cleanup);
 }
}
await main();
