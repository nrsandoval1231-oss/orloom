import { chmod, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
if (typeof root !== 'string' || process.argv.length !== 3 || !path.isAbsolute(root)) throw new Error('trusted askpass copy requires one absolute source root');
const destination = path.join(root, 'dist', 'packages', 'integration', 'src');
await mkdir(destination, { recursive: true, mode: 0o755 });
for (const name of ['git-askpass.sh', 'git-askpass.cmd', 'git-askpass.ps1']) {
  const source = path.join(root, 'packages', 'integration', 'src', name);
  const entry = await lstat(source);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16_384) throw new Error(`trusted askpass source is unsafe: ${name}`);
  if (name.endsWith('.sh') && (await readFile(source)).includes(13)) throw new Error('trusted Unix askpass source must use LF line endings');
  const target = path.join(destination, name);
  await copyFile(source, target);
  if (name.endsWith('.sh')) await chmod(target, 0o755);
}
