import { spawn } from 'node:child_process';

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
