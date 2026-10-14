import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.ORLOOM_PROOF_RUNTIME_MODULE;
const evidenceRoot = process.env.ORLOOM_PROOF_EVIDENCE_DIR;
if (!modulePath || !path.isAbsolute(modulePath) || !evidenceRoot || !path.isAbsolute(evidenceRoot)) {
  process.stderr.write('C3 suite runtime proof stopped during bootstrap (configuration); no secret values were emitted.\n');
  process.exitCode = 1;
} else {
  try { await import(pathToFileURL(modulePath).href); }
  catch (error) {
    const type = error instanceof Error ? error.name : 'unknown';
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
    const match = /runtime-proof\.mjs:(\d+):(\d+)/.exec(stack);
    const frame = match ? { line: Number(match[1]), column: Number(match[2]) } : null;
    const record = { status: 'UNKNOWN', stage: 'module-load-or-configuration', errorType: type, frame, errorDigest: createHash('sha256').update(stack).digest('hex') };
    try { await writeFile(path.join(evidenceRoot, 'proof-bootstrap-failure.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o400 }); } catch {}
    process.stderr.write(`C3 suite runtime proof stopped during bootstrap (${type}); redacted frame and stack digest were retained.\n`);
    process.exitCode = 1;
  }
}
