const PREFIX = 'ORLOOM-DIAG:v4:';
const stages = new Set([
  'dependency-lock-admission', 'typecheck', 'clean-build', 'test-discovery',
  'node-tests', 'foundation-validation', 'offline-security-policy',
]);
let framesEmitted = 0, bytesEmitted = 0;
const MAX_FRAMES = 64, MAX_BYTES = 16_384;

/** Emits fixed-field advisory telemetry; invalid measurements are dropped without affecting the check. */
export function emitSuiteDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { stage, phase, elapsedMs, outcome } = value;
  if (!stages.has(stage) || !['start', 'end'].includes(phase)
    || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 1_800_000
    || (phase === 'start' ? outcome !== undefined : !['pass', 'fail', 'unknown'].includes(outcome))) {
    return false;
  }
  return emit({ version: 'orloom.suite-diagnostics.v4', stage, phase, elapsedMs, ...(phase === 'end' ? { outcome } : {}) });
}

/** Emits one fixed-schema per-file frame. Filenames are basenames from trusted discovery. */
export function emitSuiteTestDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { phase, elapsedMs, ordinal, testFile, outcome } = value;
  if (!['start', 'end'].includes(phase) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 1_800_000
    || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 64
    || typeof testFile !== 'string' || testFile.length < 1 || testFile.length > 128 || !/^[A-Za-z0-9._-]+\.test\.js$/.test(testFile)
    || (phase === 'start' ? outcome !== undefined : !['pass', 'fail', 'unknown'].includes(outcome))) return false;
  return emit({ version: 'orloom.suite-diagnostics.v4', stage: 'node-tests', phase, elapsedMs, ordinal, testFile, ...(phase === 'end' ? { outcome } : {}) });
}

function emit(frame) {
  const line = `${PREFIX}${Buffer.from(JSON.stringify(frame)).toString('base64')}\n`;
  const bytes = Buffer.byteLength(line);
  if (framesEmitted >= MAX_FRAMES || bytesEmitted + bytes > MAX_BYTES) return false;
  framesEmitted++; bytesEmitted += bytes; process.stdout.write(line); return true;
}
