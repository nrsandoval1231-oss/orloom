import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [sourceArg, baseSha, candidateSha, manifestSha] = process.argv.slice(2);
assert.ok(sourceArg && /^[a-f0-9]{40}$/.test(baseSha ?? '') && /^[a-f0-9]{40}$/.test(candidateSha ?? '') && /^[a-f0-9]{64}$/.test(manifestSha ?? ''));
const source = path.resolve(sourceArg), ref = 'refs/heads/feat/trusted-verification-suite', candidateRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), `candidate-${candidateSha.slice(0, 7)}`), transfer = path.join(candidateRoot, 'transfer');
const git = async args => (await exec('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
assert.equal(await git(['rev-parse', 'HEAD']), candidateSha); assert.equal(await git(['rev-parse', `${ref}^{commit}`]), candidateSha); assert.equal(await git(['status', '--porcelain=v1']), ''); await git(['merge-base', '--is-ancestor', baseSha, candidateSha]);
const manifest = await readFile(path.join(source, '.agent/ORL-C3-SUITE-MANIFEST.sha256')); assert.equal(sha(manifest), manifestSha);
for (const row of manifest.toString('utf8').trimEnd().split('\n')) { const m = /^([a-f0-9]{64})  (.+)$/.exec(row); assert.ok(m); assert.equal(sha(await readFile(path.join(source, m[2]))), m[1]); }
try { await lstat(candidateRoot); throw new Error('candidate output exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(transfer, { recursive: true, mode: 0o700 });
const bundle = path.join(transfer, 'candidate.bundle'); await exec('git', ['bundle', 'create', bundle, ref], { cwd: source, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
assert.equal(await git(['bundle', 'list-heads', bundle]), `${candidateSha} ${ref}`); await exec('git', ['bundle', 'verify', bundle], { cwd: source });
const runtime = path.join(transfer, 'runtime-files'), dist = path.join(source, 'dist'); await mkdir(runtime, { mode: 0o700 }); await writeFile(path.join(runtime, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o400 });
const pending = ['packages/verification/src/repository.js', 'packages/verification/src/policy.js', 'packages/verification/src/runsc-launcher.js', 'packages/verification/src/runner.js'], copied = new Set();
while (pending.length) { const relative = pending.pop(); if (copied.has(relative)) continue; const from = path.join(dist, relative), bytes = await readFile(from); copied.add(relative); const target = path.join(runtime, 'dist', relative); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o400 }); for (const specifier of bytes.toString('utf8').matchAll(/(?:from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) { const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier[1])); assert.ok(resolved.startsWith('packages/') && resolved.endsWith('.js')); pending.push(resolved); } }
const rows = []; async function inventory(dir, prefix = '') { for (const name of (await readdir(dir)).sort()) { const file = path.join(dir, name), rel = path.posix.join(prefix, name), stat = await lstat(file); assert.ok(!stat.isSymbolicLink()); if (stat.isDirectory()) await inventory(file, rel); else { assert.ok(stat.isFile()); rows.push(`${sha(await readFile(file))}  ${rel}`); } } } await inventory(runtime); const runtimeManifest = `${rows.sort().join('\n')}\n`, runtimePayloadSha256 = sha(Buffer.from(runtimeManifest)); await writeFile(path.join(runtime, 'runtime-files.sha256'), runtimeManifest, { flag: 'wx', mode: 0o400 }); await writeFile(path.join(runtime, 'runtime-files-identity.json'), `${JSON.stringify({ format: 'orloom-c3-diagnostic-runtime-v1', candidate: candidateSha, sourceManifestSha256: manifestSha, fileCount: rows.length, payloadManifestSha256: runtimePayloadSha256 }, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
const identity = { format: 'orl-c3-suite-transfer-v1', candidateSha, baseSha, sourceRef: ref, suiteManifestSha256: manifestSha, suiteFileCount: manifest.toString('utf8').trimEnd().split('\n').length, bundleSha256: sha(await readFile(bundle)), payloadManifestSha256: runtimePayloadSha256 };
await writeFile(path.join(transfer, 'candidate-identity.json'), `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o400 }); await writeFile(path.join(transfer, 'stage-bindings.json'), `${JSON.stringify({ baseSha, candidateSha, approvedRef: ref, sourceManifestSha256: manifestSha, runtimePayloadSha256 }, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
process.stdout.write(`${JSON.stringify({ candidateRoot, transfer, identity, runtimeFiles: [...copied].sort() }, null, 2)}\n`);
