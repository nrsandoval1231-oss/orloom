const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const w=__dirname,cloud=path.join(w,'c3-delivery-cloud-v3'),candidate=path.join(cloud,'candidate-f6023acade03-v3');
const dest=path.join(w,'orloom-delivery/docs/evidence/delivery-cloud-v3');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=[];
for(const name of fs.readdirSync(path.join(candidate,'executions'))){
 const file=path.join(candidate,'executions',name);
 if(fs.statSync(file).isFile())files.push([file,'executions/'+name]);
}
for(const name of fs.readdirSync(path.join(cloud,'helpers')))files.push([path.join(cloud,'helpers',name),'helpers/'+name]);
for(const name of fs.readdirSync(w).filter(n=>n.endsWith('-delivery-cloud-v3.cjs')))files.push([path.join(w,name),'wrappers/'+name]);
files.push([path.join(candidate,'review-package-v3-complete.json'),'review-package.json'],[path.join(cloud,'source-binding-v3.json'),'source-binding.json'],[path.join(cloud,'predicate-execution-1791936279483.json'),'predicate-execution.json'],[path.join(cloud,'stage-predicate-cases-v3.json'),'predicate-cases.json'],[path.join(w,'delivery-cloud-helper-review-v3-repaired.json'),'preexecution-review.json'],[path.join(w,'delivery-cloud-runtime-review-v3.json'),'runtime-review.json']);
for(const [file] of files)if(!fs.statSync(file).isFile())throw Error('Curated file unavailable');
fs.mkdirSync(dest,{recursive:false});
const inventory=files.map(([from,to])=>{const bytes=fs.readFileSync(from),target=path.join(dest,to);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});return{file:to,bytes:bytes.length,sha256:hash(bytes)};});
fs.writeFileSync(path.join(dest,'inventory.json'),JSON.stringify({source:'f6023acade03091a494644409e9bc65d28d59ad4',files:inventory},null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(dest,'EVIDENCE.md'),'# Actual isolated cloud failure, retained\n\nSource `f6023acade03091a494644409e9bc65d28d59ad4` ran on the existing DigitalOcean host using runsc, an exact source bundle and pinned image. The PostgreSQL snapshot records attempt `3953f299-2009-4bfc-b1f4-281b638d5008` as FAIL after 271438ms, exit 1, with zero certificates. The local-integration fixture called rmdir on a Unix directory symlink and failed ENOTDIR. The expected-positive wrapper consequently recorded UNKNOWN at its assertion; that does not erase the known FAIL receipt. Remaining suite checks and negative scenarios were not established.\n\nExact source/package/helper identities, preexecution review, predicate checks, execution records, allowlisted before/after archives and independent runtime review are retained here. The owned disposable database resources were removed only after a source-bound SQL snapshot and local archive existed. Postflight verified the protected container unchanged, the verifier slot free and temporary database resources absent. No provider call, product GitHub publication or commercial completion is claimed. A separate focused branch repairs the test fixture. No runtime credentials or database connection file are included.\n',{flag:'wx'});
console.log(JSON.stringify({files:inventory.length,destination:dest}));
