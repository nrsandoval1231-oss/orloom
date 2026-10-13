import { readFile, readdir, symlink, chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ADMITTED_DEPENDENCIES, SuiteAdmissionError, admitSuiteInput, discoverSuiteTests, verifySuiteInputUnchanged } from './suite-policy.js';
import { classifySuiteStage, executeStages } from './stage-runner.js';

const root = '/work/source';
const limit = 60_000, logLimit = 65_536, start = Date.now();
const POLICY_STAGE_ORDER = Object.freeze(["dependency-lock-admission", "typecheck", "clean-build", "test-discovery", "node-tests", "foundation-validation", "offline-security-policy"]);
const out = [], err = []; let outSize = 0, errSize = 0, overflow = false, activeStage;
let admittedManifest;
function add(target, text, isOut) {
  const bytes = Buffer.from(text), next = isOut ? outSize + bytes.length : errSize + bytes.length;
  if (next > logLimit) { overflow = true; return; }
  target.push(bytes); if (isOut) outSize = next; else errSize = next;
}
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', CI: '1', NODE_ENV: 'test' };

async function* fixedStages() {
  yield { name: POLICY_STAGE_ORDER[1], file: '/usr/local/bin/node', args: ['/opt/orloom-verifier/node_modules/typescript/bin/tsc', '--noEmit'], cwd: root, env, maxLogBytes: logLimit };
  yield { name: POLICY_STAGE_ORDER[2], file: '/usr/local/bin/node', args: ['/opt/orloom-verifier/node_modules/typescript/bin/tsc'], cwd: root, env, maxLogBytes: logLimit };
  let tests;
  yield { name: POLICY_STAGE_ORDER[3], execute: async () => {
    try { tests = discoverSuiteTests(await readdir(path.join(root, 'dist/tests'))); }
    catch (error) { if (error.code === 'ENOENT') throw new SuiteAdmissionError('TypeScript build produced no test directory'); throw error; }
    if (!tests.length) throw new SuiteAdmissionError('test discovery found no tests');
    return { exitCode: 0, stdout: Buffer.from(`selected ${tests.length} Node test files\n`), stderr: Buffer.alloc(0), truncated: false };
  } };
  yield { name: POLICY_STAGE_ORDER[4], file: '/usr/local/bin/node', args: ['--test', ...tests.map(f => `dist/tests/${f}`)], cwd: root, env, maxLogBytes: logLimit };
  yield { name: POLICY_STAGE_ORDER[5], file: '/usr/local/bin/node', args: ['scripts/validate.mjs'], cwd: root, env, maxLogBytes: logLimit };
  yield { name: POLICY_STAGE_ORDER[6], execute: async () => {
    await verifySuiteInputUnchanged(root, admittedManifest.files);
    return { exitCode: 0, stdout: Buffer.from(`offline path policy pass; manifested source inputs unchanged after candidate execution; package=${ADMITTED_DEPENDENCIES['package.json']} lock=${ADMITTED_DEPENDENCIES['package-lock.json']}\n`), stderr: Buffer.alloc(0), truncated: false };
  } };
}

let result = { exitCode: 70, truncated: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
try {
  if (process.env.ORLOOM_CHECK_POLICY !== 'node-repo-suite-v1') throw new Error('trusted suite policy selection is missing or unknown');
  activeStage = POLICY_STAGE_ORDER[0];
  add(out, `STAGE ${activeStage} START\n`, true);
  admittedManifest = JSON.parse(await readFile('/work/manifest.json', 'utf8'));
  await admitSuiteInput(root, admittedManifest.files);
  await chmod(root, 0o755);
  await symlink('/opt/orloom-verifier/node_modules', path.join(root, 'node_modules'));
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
  await mkdir(path.join(root, 'dist'), { mode: 0o777 });
  async function freeze(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { await freeze(path.join(dir, entry.name)); await chmod(path.join(dir, entry.name), 0o555); }
      else if (entry.name !== 'node_modules') await chmod(path.join(dir, entry.name), 0o444);
    }
  }
  await freeze(root); await chmod(root, 0o555); await chmod(path.join(root, 'dist'), 0o777);
  add(out, `STAGE ${activeStage} END 0\n`, true); activeStage = undefined;

  const stages = await executeStages(fixedStages(), {
    remainingMs: () => limit - (Date.now() - start),
    onStart(name) { activeStage = name; add(out, `STAGE ${name} START\n`, true); },
    onEnd(name, outcome, stageResult) {
      add(out, stageResult.stdout, true); add(err, stageResult.stderr, false);
      add(out, `STAGE ${name} END ${outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : 'UNKNOWN'}\n`, true);
      activeStage = undefined;
    },
  });
  const failed = stages.find(stage => stage.outcome !== 'pass');
  if (failed) process.exitCode = failed.outcome === 'fail' ? 1 : 70;
  else process.exitCode = 0;
  result = { exitCode: overflow ? null : (process.exitCode ?? 0), truncated: overflow, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
} catch (error) {
  const rejected = error instanceof SuiteAdmissionError;
  if (activeStage) add(out, `STAGE ${activeStage} END ${rejected ? 1 : 'UNKNOWN'}\n`, true);
  add(err, `${error.message}\n`, false);
  process.exitCode = rejected ? 1 : 70;
  result = { exitCode: overflow ? null : process.exitCode, truncated: overflow, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}
const marker = { exitCode: result.exitCode, truncated: result.truncated, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, stdout: result.stdout.toString('base64'), stderr: result.stderr.toString('base64') };
process.stdout.write(`ORLOOM-RESULT:${Buffer.from(JSON.stringify(marker)).toString('base64')}\n`);
if (result.exitCode !== null) process.exit(result.exitCode === 0 ? 0 : result.exitCode === 1 ? 1 : 70);
process.exit(70);
