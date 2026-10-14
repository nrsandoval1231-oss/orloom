const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { root, fail, readHelperManifest, candidateDir, selected } = require('./common-delivery-cloud-v3.cjs');

const [expectedSha] = process.argv.slice(2);
const { bound } = readHelperManifest(expectedSha);
const chosen = selected(bound);
const command = [
  'test ! -e /var/lib/orloom/verifier/state',
  'flock -n /run/orloom-verifier-lock/slot.lock /usr/bin/true',
  'test ! -e /var/lib/orloom/c3-delivery-v3-20261013/staging/database-url',
  'test -d /var/lib/orloom/c3-delivery-v3-20261013/evidence',
  'test -d /var/lib/orloom/c3-delivery-v3-20261013/artifacts',
  'test -z "$(docker ps -aq --filter label=orloom.packet=ORL-C3-DELIVERY-CLOUD-V3)"',
  'test -z "$(docker ps -aq --filter label=orloom.packet=ORL-C3)"',
  'test -z "$(docker network ls -q --filter label=orloom.packet=ORL-C3-DELIVERY-CLOUD-V3)"',
  'test -z "$(docker volume ls -q --filter label=orloom.packet=ORL-C3-DELIVERY-CLOUD-V3)"',
  'docker inspect --format "{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.HostConfig.Runtime}}" 5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67',
].join(' && ');
const startedUtc = new Date().toISOString();
const result = cp.spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', 'codex-dark-peak-5042', command], { encoding: 'utf8', windowsHide: true });
const expected = '5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67|running|2026-10-12T23:51:46.164222792Z|0|runc';
const passed = result.status === 0 && result.stdout.trim() === expected;
const executionDir = path.join(candidateDir(bound), 'executions');
fs.mkdirSync(executionDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(executionDir, 'postflight.json'), `${JSON.stringify({ candidateSha: bound.candidateSha, helperManifestSha256: expectedSha, command, startedUtc, finishedUtc: new Date().toISOString(), exit: result.status, stdout: result.stdout, stderr: result.stderr, status: passed ? 'PASS' : 'UNKNOWN' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${passed ? 'Exact protected-container and no-resources postflight PASS' : 'Postflight UNKNOWN'}\n`);
if (!passed) process.exitCode = 1;
