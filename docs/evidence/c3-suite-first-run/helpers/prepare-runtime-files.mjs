import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Packages only compiled control modules and the locked PostgreSQL driver
// dependency tree. The full clean checkout and migrations travel separately.
const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
const source = path.resolve(process.env.ORLOOM_PROOF_SOURCE_REPO ?? '../orloom-suite');
const candidate = process.env.ORLOOM_PROOF_CANDIDATE_SHA, manifestSha = process.env.ORLOOM_PROOF_SOURCE_MANIFEST_SHA256;
const sourceRef = process.env.ORLOOM_PROOF_SOURCE_REF ?? 'refs/heads/feat/trusted-verification-suite';
const output = path.resolve(process.env.ORLOOM_PROOF_RUNTIME_FILES ?? 'runtime-files');
assert.match(candidate ?? '', /^[a-f0-9]{40}$/); assert.match(manifestSha ?? '', /^[a-f0-9]{64}$/);
const run = async args => (await exec('git', args, { cwd: source, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })).stdout.trim();
assert.equal(await run(['rev-parse', 'HEAD']), candidate); assert.equal(await run(['rev-parse', `${sourceRef}^{commit}`]), candidate);
assert.equal(await run(['status', '--porcelain=v1']), '', 'candidate checkout must be clean');
assert.equal(sha(await readFile(path.join(source, '.agent/ORL-C3-SUITE-MANIFEST.sha256'))), manifestSha, 'suite manifest digest differs');
try { await lstat(output); throw new Error('output exists; refusing overwrite'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await mkdir(output, { mode: 0o700 });
await writeFile(path.join(output, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o400 });
async function copyTree(from, to) {
  const st = await lstat(from); assert.ok(st.isDirectory() && !st.isSymbolicLink(), `unsafe source directory: ${from}`);
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(from)).sort()) {
    const src = path.join(from, name), dst = path.join(to, name), item = await lstat(src);
    assert.ok(!item.isSymbolicLink(), `symlink forbidden in runtime files: ${src}`);
    if (item.isDirectory()) await copyTree(src, dst);
    else if (item.isFile()) await cp(src, dst, { errorOnExist: true, force: false });
    else throw new Error(`special file forbidden in runtime files: ${src}`);
  }
}
async function copyCompiled(relative) {
  const from = path.join(source, 'dist', relative), to = path.join(output, 'dist', relative);
  const st = await lstat(from); assert.ok(st.isDirectory() && !st.isSymbolicLink(), `missing compiled module: ${relative}`);
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(from)).sort()) {
    const src = path.join(from, name), dst = path.join(to, name), item = await lstat(src);
    assert.ok(!item.isSymbolicLink());
    if (item.isDirectory()) await copyTree(src, dst);
    else if (item.isFile() && name.endsWith('.js')) await cp(src, dst, { errorOnExist: true, force: false });
    else if (!item.isFile()) throw new Error(`special compiled output entry: ${src}`);
  }
}
for (const relative of ['packages/contracts/src','packages/judgment/src','packages/governor/src','packages/verification/src','packages/learning/src','packages/stuck-resolver/src','apps/verifier/src']) await copyCompiled(relative);
for (const name of ['pg','pg-connection-string','pg-int8','pg-pool','pg-protocol','pg-types','pgpass','postgres-array','postgres-bytea','postgres-date','postgres-interval','split2','xtend']) await copyTree(path.join(source, 'node_modules', name), path.join(output, 'node_modules', name));
const rows = [];
async function inventory(dir, prefix = '') {
  for (const name of (await readdir(dir)).sort()) {
    const file = path.join(dir, name), relative = path.posix.join(prefix, name), st = await lstat(file);
    assert.ok(!st.isSymbolicLink());
    if (st.isDirectory()) await inventory(file, relative);
    else if (st.isFile()) rows.push(`${sha(await readFile(file))}  ${relative}`);
    else throw new Error('unexpected runtime payload entry');
  }
}
await inventory(output);
const manifest = `${rows.sort().join('\n')}\n`;
await writeFile(path.join(output, 'runtime-files.sha256'), manifest, { flag: 'wx', mode: 0o400 });
await writeFile(path.join(output, 'runtime-files-identity.json'), `${JSON.stringify({ format: 'orloom-c3-runtime-files-v1', candidate, sourceManifestSha256: manifestSha, fileCount: rows.length, payloadManifestSha256: sha(Buffer.from(manifest)) }, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
process.stdout.write(`${JSON.stringify({ candidate, fileCount: rows.length, payloadManifestSha256: sha(Buffer.from(manifest))})}\n`);
