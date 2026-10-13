import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export const ADMITTED_DEPENDENCIES = Object.freeze({
  'package.json': 'ce03aab4cd061600bbcf1930380861797b4b8fa7369204b701255df1551820df',
  'package-lock.json': '1c9fb3bc8b944f210492b4ae1a2750605d8495f349000464d17afcaa4f9ff1b4',
});
export class SuiteAdmissionError extends Error {}
export async function admitSuiteInput(root, files) {
  for (const [name, expected] of Object.entries(ADMITTED_DEPENDENCIES)) {
    let bytes;
    try { bytes = await readFile(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') throw new SuiteAdmissionError(`${name} is missing from candidate`); throw error; }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new SuiteAdmissionError(`${name} differs from admitted dependency manifest`);
  }
  for (const name of ['node_modules', '.npmrc', 'npm-shrinkwrap.json']) {
    try { await lstat(path.join(root, name)); throw new SuiteAdmissionError(`candidate override path rejected: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const hasForbiddenPath = file => {
    const parts = file.toLowerCase().split('/'), name = parts.at(-1);
    if (file === 'package-lock.json') return false;
    return parts[0] === 'dist' || (parts.includes('.github') && parts.includes('workflows')) || ['secrets', 'credentials', 'state', 'node_modules'].some(part => parts.includes(part))
      || name === '.npmrc' || name === 'credentials.json' || (name !== '.env.example' && /^\.env(?:\..*)?$/.test(name))
      || /\.(?:pem|key|p12|pfx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)
      || /^(?:npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json(?:\..*)?)$/.test(name)
      || /^\.yarnrc(?:\.yml)?$/.test(name) || /^\.pnp\./.test(name);
  };
  if (!Array.isArray(files) || !files.length || files.some(x => typeof x?.path !== 'string' || hasForbiddenPath(x.path))) throw new SuiteAdmissionError('empty input or forbidden workflow/credential/dependency configuration path');
}
export async function verifySuiteInputUnchanged(root, files) {
  if (!Array.isArray(files) || !files.length) throw new SuiteAdmissionError('input manifest is missing or empty');
  for (const item of files) {
    let bytes;
    try { bytes = await readFile(path.join(root, item.path)); }
    catch { throw new SuiteAdmissionError(`candidate input was removed or became unreadable: ${item.path}`); }
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new SuiteAdmissionError(`candidate modified manifested input: ${item.path}`);
  }
}
export function discoverSuiteTests(names) { return names.filter(name => name.endsWith('.test.js')).sort(); }
