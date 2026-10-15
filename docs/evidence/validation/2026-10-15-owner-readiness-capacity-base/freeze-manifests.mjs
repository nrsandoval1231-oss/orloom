import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const evidence='docs/evidence/validation/2026-10-15-owner-readiness-capacity-base';
const sha=b=>createHash('sha256').update(b).digest('hex');
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(p=>/^(apps|packages|tests|scripts|db|infra)\//.test(p)||/^(package(-lock)?\.json|tsconfig\.json|\.gitattributes)$/.test(p)))].sort();
const source=files.map(path=>({path,sha256:sha(readFileSync(path))}));
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(p+'/'+x.name):[p+'/'+x.name]);
const dist=walk('dist').sort().map(path=>({path,sha256:sha(readFileSync(path))}));
if(process.argv.includes('--freeze')){writeFileSync(evidence+'/source-manifest.json',JSON.stringify(source,null,2)+'\n');writeFileSync(evidence+'/executed-dist-manifest.json',JSON.stringify(dist,null,2)+'\n');}
else{
 const expected=JSON.parse(readFileSync(evidence+'/source-manifest.json'));
 const build=JSON.parse(readFileSync(evidence+'/executed-dist-manifest.json'));
 const mismatches=expected.filter(x=>sha(readFileSync(x.path))!==x.sha256);
 const buildMismatches=build.filter(x=>sha(readFileSync(x.path))!==x.sha256);
 const staged=process.argv.includes('--staged')?expected.filter(x=>sha(execFileSync('git',['show',':'+x.path],{maxBuffer:20*1024*1024}))!==x.sha256):[];
 const report={sourceEntries:expected.length,executedBuildEntries:build.length,sourceManifestSha256:sha(readFileSync(evidence+'/source-manifest.json')),sourceMismatches:mismatches,buildMismatches,stagedMismatches:staged};
 console.log(JSON.stringify(report,null,2));if(mismatches.length||buildMismatches.length||staged.length)process.exitCode=1;
}
