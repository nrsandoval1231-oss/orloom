import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Derive the executable payload from the exact delivery candidate. Copy all
// compiled modules and SQL migrations, then the dependency closure imported by
// the acceptance harness (pg) from the lockfile and installed tree. Do not
// install or resolve from a registry.
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path.resolve(process.env.ORLOOM_DELIVERY_SOURCE_REPO ?? '../orloom-delivery');
const candidate = process.env.ORLOOM_DELIVERY_CANDIDATE_SHA;
const base = process.env.ORLOOM_DELIVERY_BASE_SHA;
const sourceRef = process.env.ORLOOM_DELIVERY_SOURCE_REF;
const sourceManifestSha = process.env.ORLOOM_DELIVERY_SOURCE_MANIFEST_SHA256;
const output = path.resolve(process.env.ORLOOM_DELIVERY_RUNTIME_FILES ?? 'runtime-files');
assert.match(candidate ?? '', /^[a-f0-9]{40}$/);
assert.match(base ?? '', /^[a-f0-9]{40}$/);
assert.match(sourceManifestSha ?? '', /^[a-f0-9]{64}$/);
assert.match(sourceRef ?? '', /^refs\/heads\/[A-Za-z0-9._/-]+$/);
assert.ok(!sourceRef.includes('..'));

const git = async (...args) => (await exec('git', args, {
  cwd: source,
  windowsHide: true,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
})).stdout.trim();
assert.equal(await git('rev-parse', 'HEAD'), candidate);
assert.equal(await git('rev-parse', `${sourceRef}^{commit}`), candidate);
assert.equal(await git('status', '--porcelain=v1'), '', 'candidate checkout must be clean');
await git('merge-base', '--is-ancestor', base, candidate);
const manifestBytes = await readFile(path.join(source, '.agent/ORL-C3-SUITE-MANIFEST.sha256'));
assert.equal(sha(manifestBytes), sourceManifestSha, 'source manifest digest differs');

try {
  await lstat(output);
  throw new Error('runtime output exists; refusing overwrite');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(output, { mode: 0o700 });
await writeFile(path.join(output, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o400 });

async function copyTree(from, to) {
  const st = await lstat(from);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), `unsafe source directory: ${from}`);
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(from)).sort()) {
    const src = path.join(from, name), dst = path.join(to, name), item = await lstat(src);
    assert.ok(!item.isSymbolicLink(), `symlink forbidden in runtime payload: ${src}`);
    if (item.isDirectory() && name === 'node_modules') continue;
    else if (item.isDirectory()) await copyTree(src, dst);
    else if (item.isFile()) await cp(src, dst, { errorOnExist: true, force: false });
    else throw new Error(`special file forbidden in runtime payload: ${src}`);
  }
}

async function copyFiles(from, to, predicate) {
  const st = await lstat(from);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), `unsafe source directory: ${from}`);
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(from)).sort()) {
    const src = path.join(from, name), dst = path.join(to, name), item = await lstat(src);
    assert.ok(!item.isSymbolicLink(), `symlink forbidden in runtime payload: ${src}`);
    if (item.isDirectory()) await copyFiles(src, dst, predicate);
    else if (item.isFile() && predicate(name)) await cp(src, dst, { errorOnExist: true, force: false });
    else if (!item.isFile()) throw new Error(`special file in runtime payload: ${src}`);
  }
}

await copyFiles(path.join(source, 'dist'), path.join(output, 'dist'), name => name.endsWith('.js'));
await copyFiles(path.join(source, 'db/migrations'), path.join(output, 'db/migrations'), name => name.endsWith('.sql'));

const lock = JSON.parse(await readFile(path.join(source, 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3, 'unexpected package-lock format');
const packages = lock.packages;
assert.ok(packages && packages['']?.dependencies, 'locked production dependencies missing');

function resolveLockedPackage(fromKey, name) {
  let parent = fromKey;
  while (parent) {
    const candidateKey = `${parent ? `${parent}/` : ''}node_modules/${name}`;
    if (packages[candidateKey]) return candidateKey;
    const marker = '/node_modules/';
    const index = parent.lastIndexOf(marker);
    parent = index < 0 ? '' : parent.slice(0, index);
  }
  const rootKey = `node_modules/${name}`;
  return packages[rootKey] ? rootKey : null;
}

const dependencyKeys = new Set();
assert.ok(packages[''].dependencies.pg, 'acceptance harness pg dependency is not declared by candidate');
const pending = [{ from: '', name: 'pg' }];
const optionalExclusions = [];
while (pending.length) {
  const next = pending.pop();
  const key = resolveLockedPackage(next.from, next.name);
  assert.ok(key, `production dependency is absent from lockfile: ${next.name}`);
  if (dependencyKeys.has(key)) continue;
  dependencyKeys.add(key);
  const item = packages[key];
  const references = [
    ...Object.keys(item.dependencies ?? {}).map(name => ({ name, required: true })),
    ...Object.keys(item.optionalDependencies ?? {}).map(name => ({ name, required: false })),
    ...Object.keys(item.peerDependencies ?? {}).map(name => ({ name, required: !item.peerDependenciesMeta?.[name]?.optional })),
  ];
  for (const { name, required } of references) {
    if (!required) {
      optionalExclusions.push({ from: key, name, reason: 'not required by the acceptance harness runtime path' });
      continue;
    }
    const resolved = resolveLockedPackage(key, name);
    if (resolved) pending.push({ from: key, name });
    else throw new Error(`required production dependency is absent from lockfile: ${name} (${key})`);
  }
}
for (const key of [...dependencyKeys].sort()) {
  const from = path.join(source, key);
  const to = path.join(output, key);
  await copyTree(from, to);
}

const rows = [];
async function inventory(dir, prefix = '') {
  for (const name of (await readdir(dir)).sort()) {
    const file = path.join(dir, name), relative = path.posix.join(prefix, name), st = await lstat(file);
    assert.ok(!st.isSymbolicLink(), `symlink in payload: ${relative}`);
    if (st.isDirectory()) await inventory(file, relative);
    else if (st.isFile()) rows.push(`${sha(await readFile(file))}  ${relative}`);
    else throw new Error(`unexpected runtime payload entry: ${relative}`);
  }
}
await inventory(output);
assert.ok(rows.some(row => /  dist\/packages\/integration\/src\/delivery\.js$/.test(row)), 'composed delivery module is missing from compiled runtime inventory');
assert.ok(rows.some(row => /  db\/migrations\/\d+_delivery[^/]*\.sql$/.test(row)), 'delivery migration is missing from runtime inventory');
const relativePath = row => row.slice(row.indexOf('  ') + 2);
async function countFiles(directory, matches, prefix = '') {
  let count = 0;
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink(), `symlink in payload count: ${relative}`);
    if (stat.isDirectory()) count += await countFiles(file, matches, relative);
    else if (stat.isFile() && matches(relative)) count++;
    else if (!stat.isFile()) throw new Error(`unexpected payload count entry: ${relative}`);
  }
  return count;
}
const filesystemCounts = {
  compiledJsCount: await countFiles(output, relative => relative.startsWith('dist/') && relative.endsWith('.js')),
  migrationCount: await countFiles(output, relative => relative.startsWith('db/migrations/') && relative.endsWith('.sql')),
  dependencyPackageCount: await countFiles(output, relative => relative.startsWith('node_modules/') && relative.endsWith('/package.json')),
};
assert.equal(filesystemCounts.compiledJsCount, rows.filter(row => relativePath(row).startsWith('dist/') && row.endsWith('.js')).length, 'compiled dist JavaScript count differs from payload inventory');
assert.equal(filesystemCounts.migrationCount, rows.filter(row => relativePath(row).startsWith('db/migrations/') && row.endsWith('.sql')).length, 'migration count differs from payload inventory');
assert.equal(filesystemCounts.dependencyPackageCount, rows.filter(row => relativePath(row).startsWith('node_modules/') && relativePath(row).endsWith('/package.json')).length, 'dependency package count differs from payload inventory');
assert.equal(filesystemCounts.dependencyPackageCount, dependencyKeys.size, 'locked dependency package count differs from copied runtime package files');
const payloadManifest = `${rows.sort().join('\n')}\n`;
await writeFile(path.join(output, 'runtime-files.sha256'), payloadManifest, { flag: 'wx', mode: 0o400 });
const identity = {
  format: 'orloom-c3-delivery-cloud-runtime-v1', candidate,
  base, sourceRef, sourceManifestSha256: sourceManifestSha,
  sourceManifestFileCount: manifestBytes.toString('utf8').trimEnd().split('\n').length,
  compiledJsCount: filesystemCounts.compiledJsCount,
  migrationCount: filesystemCounts.migrationCount,
  dependencyPackageCount: dependencyKeys.size,
  dependencyRoots: ['pg'],
  optionalDependencyExclusions: optionalExclusions.sort((a, b) => `${a.from}/${a.name}`.localeCompare(`${b.from}/${b.name}`)),
  fileCount: rows.length,
  payloadManifestSha256: sha(Buffer.from(payloadManifest)),
};
await writeFile(path.join(output, 'runtime-files-identity.json'), `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
process.stdout.write(`${JSON.stringify(identity)}\n`);
