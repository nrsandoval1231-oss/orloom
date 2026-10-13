const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const repo = path.resolve('outputs/orloom');
const work = path.resolve('work/mission-postgres-proof');
const manifestPath = path.join(repo, '.agent/MISSION-ORL-005A-MANIFEST.sha256');
const manifestBytes = fs.readFileSync(manifestPath);
const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
const expected = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(expected || '') || manifestHash !== expected) throw Error('manifest identity mismatch');
const validateManifest = () => {
  for (const line of manifestBytes.toString().trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) throw Error('malformed manifest');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, match[2]))).digest('hex');
    if (actual !== match[1]) throw Error(`candidate drift: ${match[2]}`);
  }
};
validateManifest();

const dest = path.join(work, 'payload-final/app');
if (!dest.startsWith(`${work}${path.sep}`)) throw Error('output directory outside packet');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
const tsc = path.join(repo, 'node_modules/typescript/bin/tsc');
const args = [tsc, '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', repo,
  '--outDir', dest, '--skipLibCheck', '--strict', '--esModuleInterop', '--types', 'node', '--typeRoots',
  path.join(repo, 'node_modules/@types'), path.join(repo, 'packages/contracts/src/postgres-store.ts'),
  path.join(repo, 'packages/contracts/src/sql-mission-store.ts')];
const compiled = cp.spawnSync('node', args, { stdio: 'inherit' });
if (compiled.status !== 0) throw Error('TypeScript compilation failed');
fs.cpSync(path.join(repo, 'db/migrations'), path.join(dest, 'db/migrations'), { recursive: true });
fs.copyFileSync(path.join(work, 'postgres-proof.mjs'), path.join(dest, 'postgres-proof.mjs'));
fs.writeFileSync(path.join(dest, 'package.json'), '{"type":"module"}');
const packages = ['pg', 'pg-connection-string', 'pg-int8', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass',
  'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'split2', 'xtend'];
for (const name of packages) fs.cpSync(path.join(repo, 'node_modules', name), path.join(dest, 'node_modules', name), { recursive: true });
validateManifest();
fs.copyFileSync(manifestPath, path.join(work, 'candidate-manifest.sha256'));
const entries = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (entry.isFile()) {
      const relative = path.relative(dest, full).split(path.sep).join('/');
      const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      entries.push(`${hash}  ${relative}`);
    } else throw Error(`unexpected payload entry: ${full}`);
  }
};
visit(dest);
const payloadManifest = `${entries.join('\n')}\n`;
fs.writeFileSync(path.join(work, 'bundle-manifest.sha256'), payloadManifest);
const bundleHash = crypto.createHash('sha256').update(payloadManifest).digest('hex');
console.log(`manifest=${manifestHash}`);
console.log(`bundle_manifest_sha256=${bundleHash} files=${entries.length}`);
for (const relative of ['packages/contracts/src/sql-mission-store.ts', 'packages/contracts/src/postgres-store.ts',
  'packages/contracts/src/sql-store.ts', 'packages/contracts/src/mission.ts', 'db/migrations/001_initial.sql',
  'db/migrations/002_missions.sql', 'tests/missions.test.ts']) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, relative))).digest('hex');
  console.log(`${hash}  ${relative}`);
}
