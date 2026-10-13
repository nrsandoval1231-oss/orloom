const fs=require('node:fs'),cp=require('node:child_process');
const commands={
 containers:'docker ps -a --filter label=orloom.packet=ORL-C3-SUITE-PROOF --format "{{.ID}}"',
 networks:'docker network ls --filter label=orloom.packet=ORL-C3-SUITE-PROOF --format "{{.ID}}"',
 volumes:'docker volume ls --filter label=orloom.packet=ORL-C3-SUITE-PROOF --format "{{.Name}}"',
 protected:'docker inspect --format "{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Status}}" codex-universal',
 verifierCid:'docker inspect --format "{{.Id}} {{.State.Status}}" 77a228e4e41c3bf72975632b62c13fede825c5b51fc694b47d41d595715ae14f',
 slot:'test ! -e /var/lib/orloom/verifier/state && test ! -L /var/lib/orloom/verifier/state',
 credential:'test ! -e /var/lib/orloom/c3-suite-proof-20261013/staging/database-url',
 lock:'flock -n /run/orloom-verifier-lock/slot.lock /bin/true',
 events:'docker events --since 2026-10-13T10:00:00Z --until 2026-10-13T10:02:00Z --filter container=77a228e4e41c3bf72975632b62c13fede825c5b51fc694b47d41d595715ae14f --format "{{json .}}"'
};
const result={observedUtc:new Date().toISOString(),operations:{}};
for(const [key,command] of Object.entries(commands)){const r=cp.spawnSync('ssh',['-n','-o','BatchMode=yes','codex-dark-peak-5042',command],{encoding:'utf8',windowsHide:true});result.operations[key]={command,exit:r.status,stdout:r.stdout,stderr:r.stderr};}
fs.writeFileSync('work/suite-cloud-executions/post-cleanup-observation.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.operations).map(([k,v])=>[k,{exit:v.exit,bytes:v.stdout.length}]))));
