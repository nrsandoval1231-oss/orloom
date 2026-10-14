import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BareGitFastForwardIntegrator, gitAskpassCommand } from "../packages/integration/src/local.js";

const run=promisify(execFile);
async function git(args:string[]){return(await run("git",args,{windowsHide:true,timeout:15000})).stdout.trim();}

test("fixed uploader advances only the reserved ref in a controlled local bare remote",async()=>{
  const root=await mkdtemp(join(tmpdir(),"orloom remote upload spaces "));
  try{
    const source=join(root,"source repo"),integration=join(root,"integration bare.git"),remote=join(root,"destination bare.git");
    await mkdir(source);await git(["init","-q","--template=","--initial-branch=main",source]);
    await git(["-C",source,"config","user.name","Fixture"]);await git(["-C",source,"config","user.email","fixture@example.invalid"]);
    await writeFile(join(source,"tracked.txt"),"base\n");await git(["-C",source,"add","tracked.txt"]);await git(["-C",source,"commit","-qm","base"]);
    const base=await git(["-C",source,"rev-parse","HEAD"]);
    await writeFile(join(source,"tracked.txt"),"base\ncandidate\n");await git(["-C",source,"commit","-qam","candidate"]);
    const candidate=await git(["-C",source,"rev-parse","HEAD"]),tree=await git(["-C",source,"rev-parse","HEAD^{tree}"]);
    await git(["init","-q","--bare","--template=",integration]);await git(["--git-dir",integration,"fetch","-q",source,base+":refs/heads/main"]);
    await git(["--git-dir",integration,"fetch","-q",source,candidate+":refs/heads/orloom-integration"]);
    await git(["init","-q","--bare","--template=",remote]);
    const mission="11111111-1111-4111-8111-111111111111";
    const branch="orloom/delivery/"+mission+"/0123456789ab";
    const uploader=await BareGitFastForwardIntegrator.openWithTestRemote(integration,"acme/orloom",new URL("file:///"+remote.replaceAll("\\","/")).href);
    assert.equal(await uploader.readRef(),candidate);
    await uploader.uploadRef!({branch,candidateSha:candidate,protectedRefs:["main","refs/heads/release"],token:"fixture-token-that-is-never-written"});
    assert.equal(await git(["--git-dir",remote,"rev-parse","refs/heads/"+branch]),candidate);
    assert.equal(await git(["--git-dir",remote,"rev-parse","refs/heads/"+branch+"^{tree}" ]),tree);
    assert.equal(await git(["--git-dir",remote,"show-ref","--verify","--quiet","refs/heads/main"]).then(()=>true,()=>false),false);
    await assert.rejects(uploader.uploadRef!({branch:"main",candidateSha:candidate,protectedRefs:["main"],token:"fixture-token"}));
    await assert.rejects(uploader.uploadRef!({branch,candidateSha:candidate,protectedRefs:[],token:""}));
    await git(["--git-dir",integration,"config","url.file:///untrusted.insteadOf","https://github.com/acme/orloom.git"]);
    await assert.rejects(uploader.uploadRef!({branch:"orloom/delivery/11111111-1111-4111-8111-111111111111/abcdefabcdef",candidateSha:candidate,protectedRefs:[],token:"fixture-token"}));
    assert.equal(await git(["--git-dir",integration,"rev-parse","refs/heads/orloom-integration"]),candidate);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("static askpass handles paths with spaces and only the exact GitHub prompts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"orloom askpass spaces "));
  try{
    const extension=process.platform==="win32"?"cmd":"sh";
    const helper=join(root,`trusted helper.${extension}`);
    await writeFile(helper,await readFile(new URL(`../packages/integration/src/git-askpass.${extension}`,import.meta.url)),{mode:0o755});
    if(process.platform==="win32")await writeFile(join(root,"git-askpass.ps1"),await readFile(new URL("../packages/integration/src/git-askpass.ps1",import.meta.url)));
    const command=gitAskpassCommand(helper);
    const fill=(input:string)=>new Promise<string>((resolveOutput,reject)=>{const child=spawn("git",["-c","credential.helper=","credential","fill"],{env:{PATH:process.env.PATH??"",SystemRoot:process.env.SystemRoot??"",ComSpec:process.env.ComSpec??"",GIT_ASKPASS:command,GIT_TERMINAL_PROMPT:"0",ORLOOM_GIT_UPLOAD_TOKEN:"fake-token-only"},windowsHide:true});let stdout="";child.stdout.setEncoding("utf8").on("data",x=>stdout+=x);child.on("error",()=>reject(new Error("git credential fill could not start")));child.on("close",code=>code===0?resolveOutput(stdout):reject(new Error("git credential fill rejected the askpass prompt")));child.stdin.end(input);});
    const credentialFill=await fill("protocol=https\nhost=github.com\n\n");
    assert.match(credentialFill,/^username=x-access-token$/m);assert.match(credentialFill,/^password=fake-token-only$/m);
    await assert.rejects(fill("protocol=https\nhost=example.invalid\n\n"),/rejected the askpass prompt/);
    assert.throws(()=>gitAskpassCommand("bad\nhelper"));
  }finally{await rm(root,{recursive:true,force:true});}
});
