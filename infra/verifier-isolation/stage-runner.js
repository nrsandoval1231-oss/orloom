import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function classifySuiteStage(result) {
  if (!result || result.timedOut || result.spawnError || result.truncated || result.exitCode === null || result.signal) return 'unknown';
  return result.exitCode === 0 ? 'pass' : 'fail';
}

export function enforceSuiteDeadline(result, remainingMs) {
  return remainingMs() <= 0 ? { ...result, exitCode: null, timedOut: true, deadlineExceeded: true } : result;
}

export async function runStage(file, args, { cwd, timeoutMs, maxLogBytes = 65_536, env }) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch (error) { resolve({ exitCode: null, spawnError: true, error: String(error), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false }); return; }
    const stdout = [], stderr = []; let stdoutBytes = 0, stderrBytes = 0, truncated = false, timedOut = false, spawnError = false, signal;
    const collect = (chunks, chunk, size) => {
      const next = size + chunk.length;
      if (next <= maxLogBytes) chunks.push(chunk); else truncated = true;
      return next;
    };
    child.stdout.on('data', chunk => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', chunk => { stderrBytes = collect(stderr, chunk, stderrBytes); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', () => { spawnError = true; });
    child.on('close', (exitCode, childSignal) => {
      clearTimeout(timer); signal = childSignal ?? undefined;
      resolve({ exitCode: timedOut || spawnError || childSignal ? null : exitCode, timedOut, spawnError, signal, truncated, stdoutBytes, stderrBytes, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

/** Runs every trusted discovered basename once, serially, with bounded combined logs. */
export async function runSerialTestFiles(testFiles, {
  run = runStage, remainingMs, emit = () => {}, cwd, env, maxLogBytes = 65_536,
  now = () => performance.now(),
} = {}) {
  if (!Array.isArray(testFiles) || testFiles.some(file => typeof file !== 'string' || !/^[A-Za-z0-9._-]+\.test\.js$/.test(file))) {
    throw new Error('test file list must contain trusted discovered basenames');
  }
  const stdout = [], stderr = []; let stdoutBytes = 0, stderrBytes = 0;
  for (let index = 0; index < testFiles.length; index++) {
    const testFile = testFiles[index], ordinal = index + 1, began = now();
    emit({ testFile, ordinal, phase: 'start', elapsedMs: 0 });
    if (remainingMs() <= 0) {
      emit({ testFile, ordinal, phase: 'end', elapsedMs: Math.floor(Math.max(0, now() - began)), outcome: 'unknown' });
      return { exitCode: null, timedOut: true, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated: false };
    }
    const result = await run('/usr/local/bin/node', ['--test', '--test-concurrency=1', `dist/tests/${testFile}`], {
      cwd, env, timeoutMs: remainingMs(), maxLogBytes,
    });
    const elapsedMs = Math.floor(Math.max(0, now() - began));
    const boundedResult = enforceSuiteDeadline(result, remainingMs);
    const outcome = classifySuiteStage(boundedResult);
    emit({ testFile, ordinal, phase: 'end', elapsedMs, outcome });
    const nextOut = stdoutBytes + boundedResult.stdout.length, nextErr = stderrBytes + boundedResult.stderr.length;
    if (nextOut > maxLogBytes || nextErr > maxLogBytes) return { exitCode: null, truncated: true, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    stdout.push(boundedResult.stdout); stdoutBytes = nextOut;
    stderr.push(boundedResult.stderr); stderrBytes = nextErr;
    if (outcome !== 'pass') return { ...boundedResult, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }
  return { exitCode: 0, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated: false };
}

/** Executes a trusted internal iterable serially and never starts a later stage after a non-pass. */
export async function executeStages(stages, { run = runStage, remainingMs, onStart = () => {}, onEnd = () => {} }) {
  const results = [];
  for await (const stage of stages) {
    onStart(stage.name);
    const budget = remainingMs();
    let result = budget <= 0
      ? { exitCode: null, timedOut: true, spawnError: false, truncated: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      : stage.execute
        ? await stage.execute()
        : await run(stage.file, stage.args, { cwd: stage.cwd, timeoutMs: budget, maxLogBytes: stage.maxLogBytes, env: stage.env });
    result = enforceSuiteDeadline(result, remainingMs);
    const outcome = classifySuiteStage(result);
    onEnd(stage.name, outcome, result);
    results.push({ name: stage.name, outcome, result });
    if (outcome !== 'pass') break;
  }
  return results;
}
