import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Clean, exact-source build plus the same narrow compiled-module/pg packaging pattern as C3.
const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
const candidate = '8f271de796e643a3a0b9b47b80fc1de3e3646d9d';
const source = await (await import('node:fs/promises')).realpath(process.env.ORLOOM_C1B_SOURCE_ROOT ?? 'work/orloom-learning');
const helperRoot = path.resolve('rootwork/c1b-integrated-proof');
const output = path.resolve(process.env.ORLOOM_C1B_RUNTIME_PAYLOAD ?? path.join(helperRoot, 'runtime-payload'));
const build = path.resolve(process.env.ORLOOM_C1B_CLEAN_BUILD ?? path.join(helperRoot, 'clean-build'));
const git = async (...args) => (await exec('git', args, { cwd: source, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const npm = async (...args) => process.platform === 'win32'
  ? exec('cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd: build, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  : exec('npm', args, { cwd: build, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
assert.equal(await git('rev-parse', 'HEAD'), candidate);
assert.equal(await git('status', '--porcelain=v1'), '', 'source checkout must be clean');
for (const target of [build, output]) await assert.rejects(lstat(target), e => e?.code === 'ENOENT');
await exec('git', ['-c', 'core.longpaths=true', 'worktree', 'add', '--detach', build, candidate], { cwd: source, windowsHide: true });
try {
  await npm('ci'); await npm('run', 'clean'); await npm('run', 'build');
  await mkdir(output, { recursive: false, mode: 0o700 });
  await writeFile(path.join(output, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o400 });
  const copyTree = async (from, to) => {
    const st = await lstat(from); assert.ok(st.isDirectory() && !st.isSymbolicLink()); await mkdir(to, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(from)).sort()) { const src = path.join(from, name), dst = path.join(to, name), item = await lstat(src); assert.ok(!item.isSymbolicLink()); if (item.isDirectory()) await copyTree(src, dst); else if (item.isFile()) await cp(src, dst, { errorOnExist: true, force: false }); else throw new Error('special runtime dependency entry'); }
  };
  const copyCompiled = async relative => {
    const from = path.join(build, 'dist', relative), to = path.join(output, 'dist', relative); await mkdir(to, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(from)).sort()) { const src = path.join(from, name), dst = path.join(to, name), st = await lstat(src); assert.ok(!st.isSymbolicLink()); if (st.isDirectory()) await copyTree(src, dst); else if (st.isFile() && name.endsWith('.js')) await cp(src, dst, { errorOnExist: true, force: false }); else if (!st.isFile()) throw new Error('special compiled runtime entry'); }
  };
  for (const relative of ['packages/contracts/src','packages/judgment/src','packages/governor/src','packages/verification/src','packages/learning/src','packages/stuck-resolver/src','packages/config/src','apps/control-plane/src','apps/verifier/src']) await copyCompiled(relative);
  for (const name of ['pg','pg-connection-string','pg-int8','pg-pool','pg-protocol','pg-types','pgpass','postgres-array','postgres-bytea','postgres-date','postgres-interval','split2','xtend']) await copyTree(path.join(build, 'node_modules', name), path.join(output, 'node_modules', name));
  await cp(path.join(build, 'db', 'migrations'), path.join(output, 'db-migrations'), { recursive: true, errorOnExist: true, force: false });
  const rows = [];
  const inventory = async (dir, prefix = '') => { for (const name of (await readdir(dir)).sort()) { const file = path.join(dir, name), rel = path.posix.join(prefix, name), st = await lstat(file); assert.ok(!st.isSymbolicLink()); if (st.isDirectory()) await inventory(file, rel); else if (st.isFile()) rows.push(`${sha(await readFile(file))}  ${rel}`); else throw new Error('special payload file'); } };
  await inventory(output); const manifest = `${rows.sort().join('\n')}\n`, payloadSha = sha(Buffer.from(manifest));
  await writeFile(path.join(output, 'runtime-files.sha256'), manifest, { flag: 'wx', mode: 0o400 });
  await writeFile(path.join(output, 'runtime-files-identity.json'), `${JSON.stringify({ format: 'orloom-c1b-runtime-payload-v1', candidate, cleanBuild: true, fileCount: rows.length, payloadManifestSha256: payloadSha }, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  process.stdout.write(`${JSON.stringify({ status: 'CLEAN_RUNTIME_PAYLOAD_PREPARED', candidate, fileCount: rows.length, payloadManifestSha256: payloadSha })}\n`);
} finally { await exec('git', ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', build], { cwd: source, windowsHide: true }); }
