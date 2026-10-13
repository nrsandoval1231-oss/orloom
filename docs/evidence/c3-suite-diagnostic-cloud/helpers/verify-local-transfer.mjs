import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const exec=promisify(execFile), transfer=path.resolve(process.argv[2] ?? ''); assert.ok(transfer);
const identity=JSON.parse(await readFile(path.join(transfer,'candidate-identity.json'),'utf8')), runtime=path.join(transfer,'runtime-files');
const bare=await mkdtemp(path.join(os.tmpdir(),'orl-c3-diagnostic-bare-')); try { await rm(bare,{recursive:true,force:true}); await exec('git',['clone','--bare',path.join(transfer,'candidate.bundle'),bare]); const [{extractCandidateBundle},{getCheckPolicy}]=await Promise.all([import(pathToFileURL(path.join(runtime,'dist/packages/verification/src/repository.js')).href),import(pathToFileURL(path.join(runtime,'dist/packages/verification/src/policy.js')).href)]); const bundle=await extractCandidateBundle({objectStore:bare,approvedRef:identity.sourceRef},identity.baseSha,identity.candidateSha); const policy=getCheckPolicy('node-repo-suite-v1',`sha256:${'0'.repeat(64)}`,'0'.repeat(64)); assert.equal(policy.timeoutMs,60000); assert.ok(bundle.files.size>0); process.stdout.write(JSON.stringify({files:bundle.files.size,inputBundleDigest:bundle.digest,policyDigest:policy.digest})+'\n'); } finally { await rm(bare,{recursive:true,force:true}); }
