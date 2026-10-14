const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { root, sha, fail, readHelperManifest, candidateDir, selected } = require('./common-delivery-cloud-v3.cjs');

const [expectedSha, name, ...args] = process.argv.slice(2);
const { bound } = readHelperManifest(expectedSha);
const chosen = selected(bound);
const allowed = new Set(['preflight-acceptance.sh', 'stage-acceptance.sh', 'setup-disposable-postgres.sh', 'build-suite-image.sh', 'run-acceptance.sh', 'export-acceptance-snapshot.sh', 'cleanup-acceptance.sh']);
if (!allowed.has(name) || args.some(arg => !/^[A-Za-z0-9_./:-]+$/.test(arg))) fail('Unexpected delivery-cloud helper or argument');
if (chosen.runtimeAttempt?.status !== 'NOT-RUN') fail('Runtime attempt is already recorded; preserve UNKNOWN and do not redispatch');
if (name === 'setup-disposable-postgres.sh') {
  const exactPreflight = '/var/lib/orloom/c3-delivery-v3-20261013.incoming/preflight/preflight.json';
  if (args.length !== 1 || args[0] !== exactPreflight) fail('PostgreSQL setup requires the exact fresh incoming preflight record');
} else if (args.length) fail('Unexpected helper arguments');
const script = fs.readFileSync(path.join(root, 'helpers', name), 'utf8').replace(/\r\n/g, '\n');
const executionDir = path.join(candidateDir(bound), 'executions');
fs.mkdirSync(executionDir, { recursive: true, mode: 0o700 });
const started = new Date(), id = `${started.toISOString().replace(/[:.]/g, '-')}-${name}`;
const logPrefix = path.join(executionDir, id);
const stdout = fs.openSync(`${logPrefix}.stdout.log`, 'wx'), stderr = fs.openSync(`${logPrefix}.stderr.log`, 'wx');
const child = cp.spawn('ssh', ['-T', '-o', 'BatchMode=yes', 'codex-dark-peak-5042', 'bash', '-s', '--', ...args], { stdio: ['pipe', stdout, stderr], windowsHide: true });
child.stdin.end(script);
child.on('error', error => { fs.closeSync(stdout); fs.closeSync(stderr); fail(`SSH helper did not start: ${error.message}`); });
child.on('close', (exit, signal) => {
  fs.closeSync(stdout); fs.closeSync(stderr);
  const finished = new Date();
  const record = { name, args, scriptSha256: sha(Buffer.from(script)), helperManifestSha256: expectedSha, candidateSha: bound.candidateSha, startedUtc: started.toISOString(), finishedUtc: finished.toISOString(), elapsedMs: finished.getTime() - started.getTime(), exit, signal, logPrefix };
  fs.writeFileSync(`${logPrefix}.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = exit === 0 ? 0 : 1;
});
