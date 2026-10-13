const PREFIX = 'ORLOOM-DIAG:v2:';
const stages = new Set([
  'dependency-lock-admission', 'typecheck', 'clean-build', 'test-discovery',
  'node-tests', 'foundation-validation', 'offline-security-policy',
]);
let framesEmitted = 0, bytesEmitted = 0;

/** Emits fixed-field advisory telemetry; invalid measurements are dropped without affecting the check. */
export function emitSuiteDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { stage, phase, elapsedMs, outcome } = value;
  if (!stages.has(stage) || !['start', 'end'].includes(phase)
    || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 180_000
    || (phase === 'start' ? outcome !== undefined : !['pass', 'fail', 'unknown'].includes(outcome))) {
    return false;
  }
  const frame = { version: 'orloom.suite-diagnostics.v2', stage, phase, elapsedMs, ...(phase === 'end' ? { outcome } : {}) };
  const line = `${PREFIX}${Buffer.from(JSON.stringify(frame)).toString('base64')}\n`;
  const bytes = Buffer.byteLength(line);
  if (framesEmitted >= 16 || bytesEmitted + bytes > 4096) return false;
  framesEmitted++; bytesEmitted += bytes;
  process.stdout.write(line);
  return true;
}
