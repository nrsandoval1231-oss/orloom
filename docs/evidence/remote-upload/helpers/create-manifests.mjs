import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const arg=(name)=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1]};
const source=resolve(arg("--source")??""),expected=arg("--expected-sha");
if(!process.argv.includes("--authorize-local-proof")||!/^[a-f0-9]{40}$/.test(expected??""))throw new Error("explicit local proof authorization and exact frozen SHA are required");
const run=(file,args)=>new Promise((ok,no)=>{const child=spawn(file,args,{cwd:source,windowsHide:true,stdio:["ignore","pipe","ignore"]});let out="";child.stdout.setEncoding("utf8").on("data",x=>out+=x);child.once("error",no);child.once("close",code=>code===0?ok(out.trim()):no(Error(`manifest preflight command failed: ${file}`)))});
if(await run("git",["rev-parse","HEAD"])!==expected)throw new Error("source HEAD differs from expected frozen SHA");
if(await run("git",["status","--porcelain"]))throw new Error("source must be clean before creating manifests");
const hash=async(file)=>createHash("sha256").update(await readFile(file)).digest("hex");
async function allJs(root,dir=""){const result=[];for(const entry of await readdir(join(root,dir),{withFileTypes:true})){const relative=join(dir,entry.name);if(entry.isDirectory())result.push(...await allJs(root,relative));else if(entry.isFile()&&entry.name.endsWith(".js"))result.push(relative)}return result}
const dist=join(source,"dist"),compiledFiles={};
for(const relative of (await allJs(dist)).map(p=>"dist/"+p.replaceAll("\\","/")).sort())compiledFiles[relative]=await hash(join(source,relative));
const names=["git-askpass.sh","git-askpass.cmd","git-askpass.ps1"],helperFiles={};
for(const name of names){const sourceRelative=`packages/integration/src/${name}`,distRelative=`dist/packages/integration/src/${name}`,sourcePath=join(source,sourceRelative),distPath=join(source,distRelative);const a=await hash(sourcePath),b=await hash(distPath);if(a!==b)throw new Error(`copied helper differs from source: ${name}`);const info=await stat(distPath);if(!info.isFile()||info.size>16384)throw new Error(`copied helper is not a bounded regular file: ${name}`);if(name.endsWith(".sh")&&process.platform!=="win32"&&(info.mode&0o111)===0)throw new Error("copied Unix askpass helper lacks executable mode");helperFiles[sourceRelative]=a;helperFiles[distRelative]=b}
const compiled=join(import.meta.dirname,`compiled-${expected}.json`),helpers=join(import.meta.dirname,`helpers-${expected}.json`);
await writeFile(compiled,JSON.stringify({candidateSha:expected,files:compiledFiles},null,2)+"\n",{flag:"wx"});
await writeFile(helpers,JSON.stringify({candidateSha:expected,files:helperFiles},null,2)+"\n",{flag:"wx"});
process.stdout.write(JSON.stringify({candidateSha:expected,compiledManifest:compiled,compiledJs:Object.keys(compiledFiles).length,helperManifest:helpers,helpers:Object.keys(helperFiles).length})+"\n");
