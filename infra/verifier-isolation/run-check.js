import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const input = '/work';
const checkPolicy = process.env.ORLOOM_CHECK_POLICY;
if (checkPolicy !== 'node-validate-syntax' && checkPolicy !== 'node-repo-suite-v1') process.exit(64);
const manifest = JSON.parse(await readFile(path.join(input, 'manifest.json'), 'utf8'));
if (manifest.version !== 'orloom.input-manifest.v1' || !Array.isArray(manifest.files) || manifest.files.length > 4000) process.exit(64);
let total = 0;
for (const item of manifest.files) {
  if (!item || typeof item.path !== 'string' || item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some(p => !p || p === '.' || p === '..')) process.exit(64);
  const file = path.join(input, 'source', item.path);
  const bytes = await readFile(file);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== item.sha256 || bytes.length !== item.bytes || bytes.length > 4 * 1024 * 1024) process.exit(65);
  total += bytes.length;
  if (total > 16 * 1024 * 1024) process.exit(65);
}
if (checkPolicy === 'node-repo-suite-v1') {
  const child = spawn('/usr/local/bin/node', ['/opt/orloom-verifier/run-repo-suite.js'], {
    cwd: path.join(input, 'source'), env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', CI: '1', ORLOOM_CHECK_POLICY: 'node-repo-suite-v1' },
    stdio: 'inherit', shell: false,
  });
  const code = await new Promise(resolve => { child.on('close', (c, signal) => resolve(signal ? 70 : c ?? 70)); child.on('error', () => resolve(70)); });
  process.exit(code);
}
const stdout = [], stderr = [];
const child = spawn('/usr/local/bin/node', ['--check', 'scripts/validate.mjs'], {
  cwd: path.join(input, 'source'), env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], shell: false,
});
let outBytes = 0, errBytes = 0, overflow = false;
child.stdout.on('data', chunk => { outBytes += chunk.length; if (outBytes <= 65536) stdout.push(chunk); else overflow = true; });
child.stderr.on('data', chunk => { errBytes += chunk.length; if (errBytes <= 65536) stderr.push(chunk); else overflow = true; });
const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
const code = await new Promise(resolve => { child.on('close', (c, signal) => resolve(signal ? null : c)); child.on('error', () => resolve(null)); });
clearTimeout(timer);
const result = { exitCode: code, truncated: overflow, stdoutBytes: outBytes, stderrBytes: errBytes,
  stdout: Buffer.concat(stdout).toString('base64'), stderr: Buffer.concat(stderr).toString('base64') };
process.stdout.write(`ORLOOM-RESULT:${Buffer.from(JSON.stringify(result)).toString('base64')}\n`);
if (code === null || overflow) process.exit(70);
process.exit(code === 0 ? 0 : 1);
