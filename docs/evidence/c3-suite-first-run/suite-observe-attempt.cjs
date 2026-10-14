const fs = require('node:fs');
const cp = require('node:child_process');
const script = `const fs = require('node:fs');
const { Client } = require('/var/lib/orloom/c3-suite-proof-20261013/source/node_modules/pg');
(async()=>{const c=new Client({connectionString:fs.readFileSync('/var/lib/orloom/c3-suite-proof-20261013/staging/database-url','utf8').trim()});
try{await c.connect();const attempts=await c.query('SELECT outcome,request,receipt FROM verification_attempts');const certs=await c.query('SELECT count(*)::int AS count FROM check_certificates');
const result={observedUtc:new Date().toISOString(),attempts:attempts.rows,certificateCount:certs.rows[0].count};
fs.writeFileSync('/var/lib/orloom/c3-suite-proof-20261013/evidence/attempt-state-after-failure.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o400});console.log(JSON.stringify({attempts:attempts.rows.length,certificateCount:result.certificateCount,outcomes:attempts.rows.map(r=>r.outcome)}));}
catch(e){console.error('Read-only observation failed: '+e.name);process.exitCode=1;}finally{await c.end();}})();`;
const r=cp.spawnSync('ssh',['-T','-o','BatchMode=yes','codex-dark-peak-5042','/var/lib/orloom/c3-suite-proof-20261013/staging/node -'],{input:script,encoding:'utf8',windowsHide:true});
fs.writeFileSync('work/suite-cloud-executions/attempt-observation.log',r.stdout+r.stderr,{flag:'wx'});
console.log(r.stdout); process.exitCode=r.status===0?0:1;

