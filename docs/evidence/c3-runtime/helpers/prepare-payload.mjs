import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.env.ORLOOM_PROOF_SOURCE ?? path.join(here, '..', 'orloom-ci'));
const expectedHead = process.env.ORLOOM_PROOF_CANDIDATE_SHA;
const baseSha = process.env.ORLOOM_PROOF_BASE_SHA;
const sourceRef = process.env.ORLOOM_PROOF_SOURCE_REF ?? 'refs/heads/feat/trusted-verification';
const expectedManifestSha = process.env.ORLOOM_PROOF_SOURCE_MANIFEST_SHA256;
assert.match(expectedHead ?? '', /^[a-f0-9]{40}$/);
assert.match(baseSha ?? '', /^[a-f0-9]{40}$/);
assert.match(expectedManifestSha ?? '', /^[a-f0-9]{64}$/);
assert.match(sourceRef, /^refs\/heads\/[A-Za-z0-9._/-]+$/);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), expectedHead, 'source HEAD differs from frozen candidate');
assert.equal(execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' }).trim(), '', 'source checkout must be clean');
execFileSync('git', ['merge-base', '--is-ancestor', baseSha, expectedHead], { cwd: repo, stdio: 'ignore' });
assert.equal(execFileSync('git', ['rev-parse', `${sourceRef}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim(), expectedHead, 'approved source ref does not identify frozen candidate');
const sourceManifest = await readFile(path.join(repo, '.agent', 'ORL-C3-MANIFEST.sha256'));
assert.equal(createHash('sha256').update(sourceManifest).digest('hex'), expectedManifestSha, 'frozen source manifest changed');
for (const line of sourceManifest.toString('utf8').trimEnd().split('\n')) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
  assert(match, 'invalid frozen source manifest row');
  const parts = match[2].split('/'); assert(!parts.some(p => p === '..' || p === '.' || p === ''), 'unsafe source manifest path');
  const file = path.resolve(repo, ...parts); assert(file.startsWith(`${repo}${path.sep}`), 'manifest path escaped checkout');
  const st = await lstat(file); assert(st.isFile() && !st.isSymbolicLink(), 'manifest entry is not a regular file');
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), match[1], `source manifest mismatch: ${match[2]}`);
}
const output = path.join(here, 'payload');
try { await lstat(output); throw new Error('payload already exists; refusing overwrite'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const bundlePath = path.join(here, 'candidate.bundle');
try { await lstat(bundlePath); throw new Error('bundle already exists; refusing overwrite'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
execFileSync('git', ['bundle', 'create', bundlePath, sourceRef], { cwd: repo, stdio: 'inherit' });
execFileSync('git', ['bundle', 'verify', bundlePath], { cwd: repo, stdio: 'ignore' });
assert.equal(execFileSync('git', ['bundle', 'list-heads', bundlePath], { cwd: repo, encoding: 'utf8' }).trim(), `${expectedHead} ${sourceRef}`);

const app = path.join(output, 'orloom-ci');
const addFile = async (from, to) => {
  const st = await lstat(from);
  assert(st.isFile() && !st.isSymbolicLink(), `source must be regular file: ${from}`);
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await cp(from, to);
};
const addTree = async (from, to) => {
  const st = await lstat(from); assert(st.isDirectory() && !st.isSymbolicLink(), 'dependency root must be ordinary directory');
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const ent of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, ent.name), dest = path.join(to, ent.name), child = await lstat(src);
    if (child.isSymbolicLink()) throw new Error('dependency symlinks are forbidden');
    if (child.isDirectory()) await addTree(src, dest);
    else if (child.isFile()) await addFile(src, dest);
    else throw new Error('dependency special file is forbidden');
  }
};
const addCompiled = async rel => {
  const root = path.join(repo, 'dist', rel);
  const walk = async (src, dst) => {
    for (const ent of (await readdir(src, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const s = path.join(src, ent.name), d = path.join(dst, ent.name);
      if (ent.isSymbolicLink()) throw new Error('symlink in compiled output');
      if (ent.isDirectory()) await walk(s, d);
      else if (ent.isFile() && ent.name.endsWith('.js')) await addFile(s, d);
      else if (!ent.isFile()) throw new Error('unexpected compiled output entry');
    }
  };
  await walk(root, path.join(app, 'dist', rel));
};
for (const rel of ['packages/contracts/src', 'packages/judgment/src', 'packages/governor/src', 'packages/verification/src', 'packages/learning/src', 'packages/stuck-resolver/src', 'apps/verifier/src']) await addCompiled(rel);
for (const f of await readdir(path.join(repo, 'db', 'migrations'))) if (/^\d+_[a-z0-9_]+\.sql$/.test(f)) await addFile(path.join(repo, 'db', 'migrations', f), path.join(app, 'db', 'migrations', f));
for (const name of ['pg','pg-connection-string','pg-int8','pg-pool','pg-protocol','pg-types','pgpass','postgres-array','postgres-bytea','postgres-date','postgres-interval','split2','xtend']) {
  const src = path.join(repo, 'node_modules', name), dest = path.join(app, 'node_modules', name);
  for (const ent of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) throw new Error('dependency symlink is not allowed');
    if (ent.isDirectory()) await addTree(s, d);
    else if (ent.isFile()) await addFile(s,d); else throw new Error('unexpected dependency entry');
  }
}
await writeFile(path.join(app, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
const runner = path.join(output, 'c3-runtime-proof'); await mkdir(runner, { recursive: true, mode: 0o700 });
await cp(path.join(here, 'runtime-proof.mjs'), path.join(runner, 'runtime-proof.mjs'), { errorOnExist: true, force: false });
const rows = [];
const walk = async d => { for (const ent of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) { const p=path.join(d,ent.name); if(ent.isSymbolicLink()) throw new Error('payload symlink'); if(ent.isDirectory()) await walk(p); else if(ent.isFile()) rows.push(`${createHash('sha256').update(await readFile(p)).digest('hex')}  ${path.relative(output,p).split(path.sep).join('/')}`); else throw new Error('unexpected payload entry'); } };
await walk(output);
const bundleHash = createHash('sha256').update(await readFile(bundlePath)).digest('hex');
const manifest = `${rows.sort().join('\n')}\n`;
await writeFile(path.join(here, 'payload-manifest.sha256'), manifest, { flag: 'wx', mode: 0o600 });
const identity = { candidateSha: expectedHead, baseSha, sourceRef, sourceManifestSha256: expectedManifestSha, bundleSha256: bundleHash, payloadManifestSha256: createHash('sha256').update(manifest).digest('hex'), fileCount: rows.length, repository: 'nrsandoval1231-oss/orloom' };
await writeFile(path.join(here, 'payload-identity.json'), `${JSON.stringify(identity,null,2)}\n`, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(here, 'source-identity.json'), `${JSON.stringify({ candidateSha: expectedHead, baseSha, sourceRef, repository: identity.repository },null,2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(identity)}\n`);
