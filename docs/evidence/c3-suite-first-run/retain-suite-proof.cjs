const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const name = process.argv[2];
if (!/^[a-z-]+$/.test(name || '')) throw Error('Invalid archive name');
const dir = path.join(__dirname, 'suite-cloud-executions');
const file = path.join(dir, `${name}.tar.gz`);
const fd = fs.openSync(file, 'wx');
// Explicit evidence-only allowlist. Never archive staging/database-url or volumes.
const command = 'tar -czf - -C /var/lib/orloom/c3-suite-proof-20261013 evidence artifacts fixtures/fixtures.json resources.tsv capacity-evidence.json setup-capacity.json database-inspect.json verifier-image.id verifier-image-inspect.json staging/staging-identity.txt incoming/candidate-identity.json';
const result = cp.spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', 'codex-dark-peak-5042', command], {stdio:['ignore', fd, 'pipe'], windowsHide:true});
fs.closeSync(fd);
const bytes = fs.readFileSync(file);
const record = {file, bytes:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex'), exit:result.status, observedUtc:new Date().toISOString(), allowlist:command};
fs.writeFileSync(`${file}.json`, JSON.stringify(record,null,2)+'\n', {flag:'wx'});
console.log(JSON.stringify(record));
if(result.status !== 0) process.exitCode=1;
