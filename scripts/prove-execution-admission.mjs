// Credential-free proof against real commit objects. No worker/provider execution.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CandidateAdmission, CANDIDATE_ADMISSION_LIMITS } from '../dist/packages/verification/src/candidate-admission.js';
import { TRUSTED_CHECK_LIMITS } from '../dist/packages/contracts/src/verification.js';
const [source, baseSha, candidateSha, output, projection] = process.argv.slice(2);
if (!source || !/^[a-f0-9]{40}$/.test(baseSha ?? '') || !/^[a-f0-9]{40}$/.test(candidateSha ?? '') || !output) throw new Error('usage: node scripts/prove-execution-admission.mjs SOURCE BASE_SHA CANDIDATE_SHA OUTPUT');
const git = (repo, ...args) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { maxBuffer: 24_000_000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(path.join(os.tmpdir(), 'orloom-real-admission-'));
try {
  const trusted = path.join(root,'trusted.git'), admissions = path.join(root,'admissions');
  await mkdir(admissions,{mode:0o700});
  git(source,'clone','--bare','--no-hardlinks',source,trusted);
  git(trusted,'update-ref','refs/heads/proof-base',baseSha);
  git(trusted,'update-ref','refs/heads/orloom-candidate',candidateSha);
  const bundlePath=path.join(root,'candidate.bundle');
  git(trusted,'bundle','create',bundlePath,'refs/heads/orloom-candidate',`^${baseSha}`);
  const bytes=await readFile(bundlePath),bundleKey=`sha256/${hash(bytes)}`;
  const binding={version:'orloom.candidate-admission.v1',missionId:'real-git-admission-proof',sliceId:'admission',leaseEpoch:1,repository:'nrsandoval1231-oss/orloom',baseSha,candidateSha,planDigest:hash('admission proof only'),trustedCheckPolicyDigest:hash('no sandbox dispatched'),scopes:['**'],evidenceRefs:[]};
  const index=Buffer.from(JSON.stringify({version:'orloom.worker-evidence-index.v1',...Object.fromEntries(['missionId','sliceId','leaseEpoch','baseSha','planDigest','trustedCheckPolicyDigest'].map(k=>[k,binding[k]])),entries:[{name:'candidate-bundle',key:bundleKey,sha256:hash(bytes),reference:`candidate-bundle:${bundleKey}`}]}));
  const indexKey=`sha256/${hash(index)}`;binding.evidenceRefs=[`candidate-bundle:${bundleKey}`,`evidence-index:${indexKey}`];
  const values=new Map([[bundleKey,bytes],[indexKey,index]]);
  const artifacts={async getBounded(key,max){const value=values.get(key);assert(value && value.length<=max);return value;}};
  const config={objectStore:trusted,approvedRef:'refs/heads/proof-base'};
  const options={root:admissions,repositories:{[binding.repository]:config},artifacts};
  await assert.rejects(new CandidateAdmission(options).admit(binding),/input bounds|input cap/);
  config.executionInputProfile='orloom-execution-v1';
  const admission=new CandidateAdmission(options),started=performance.now();
  const admitted=await admission.admit(binding),cached=await admission.admit(binding);
  assert.equal(cached.input.digest,admitted.input.digest);
  if (projection) {
    await mkdir(projection,{recursive:false});
    for (const [name,content] of admitted.input.files) {
      const destination=path.join(projection,name);
      await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,content);
    }
  }
  const fullListing=git(trusted,'ls-tree','-rl',candidateSha).toString();
  assert.equal(git(admitted.repository.objectStore,'ls-tree','-rl',candidateSha).toString(),fullListing);
  const inputBytes=[...admitted.input.files.values()].reduce((n,b)=>n+b.length,admitted.input.manifest.length);
  assert(inputBytes<=TRUSTED_CHECK_LIMITS.maxInputBundleBytes);
  const report={baseSha,candidateSha,treeSha:admitted.receipt.treeSha,elapsedMs:Math.round(performance.now()-started),inputBytes,selectedFiles:admitted.input.files.size,manifestBytes:admitted.input.manifest.length,inputDigest:admitted.input.digest,fullTreeUnchanged:true,defaultFullTreeRejected:true,manifest:JSON.parse(admitted.input.manifest),limits:{...CANDIDATE_ADMISSION_LIMITS,...TRUSTED_CHECK_LIMITS},scope:'real Git candidate admission and cached reread; no isolated runtime or autonomous task completion'};
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,manifest:undefined}));
} finally {await rm(root,{recursive:true,force:true});}
