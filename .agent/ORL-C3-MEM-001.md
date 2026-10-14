# ORL-C3-MEM-001 — serial per-test memory diagnostics

**State:** repair 1 implemented after independent source review returned `FIX` for missing behavioral coverage; repair checks PASS; cloud/runtime result UNKNOWN and not attempted. This packet adds diagnostic source only and makes no acceptance or operational claim.

## Packet and boundary

- Repository: `work/orloom-suite`, branch `feat/trusted-verification-suite`.
- Original base: `6b4d6832cfa2e58997fc1e0d1d0a22fa68ba1af9`. Repair-1 base is the controller-frozen review candidate `0b85d05c3c53c0d6667803078033a52dd190664d`.
- Objective: isolate each trusted discovered test file in its own serial Node invocation and retain bounded basename/ordinal/elapsed/outcome telemetry.
- Controller-approved additions: `packages/verification/src/runsc-launcher.ts` strict protocol parser and `packages/verification/src/policy.ts` diagnostics contract/version/digest binding. No launcher, resource, stage classification, policy limit, contract, or syntax-policy behavior change.
- Owned files: `infra/verifier-isolation/run-repo-suite.js`, `infra/verifier-isolation/stage-runner.js`, `infra/verifier-isolation/suite-diagnostics.js`, `packages/verification/src/runsc-launcher.ts`, `packages/verification/src/policy.ts`, `tests/verification-runner.test.ts`, and this packet/handoff plus `.agent/ORL-C3-SUITE-MANIFEST.sha256`.
- Excluded: all host/provider/state/evidence operations, app/PGlite/package changes, resource/deadline changes, external actions, commits, pushes, and merges.

## Implementation and invariants

The suite discovers and sorts all `*.test.js` basenames, then invokes `/usr/local/bin/node --test --test-concurrency=1 dist/tests/<basename>` once per file in order through the production `runSerialTestFiles` helper. A non-pass result or exhausted shared suite deadline, including a process result arriving after the deadline, stops later invocations and fails closed. Combined stdout/stderr remains capped at 65,536 bytes. Telemetry return values and ordinal/frame caps never control test selection or invocation.

Diagnostics v3 is advisory only: maximum 64 frames and 16,384 bytes, stage elapsed maximum 180,000 ms, test ordinal maximum 64 (telemetry bound only), basename maximum 128 bytes, and strict typed/ordered stage and per-file start/end frames. The host parser retains only complete, ordered, fixed-schema frames. It preserves exact final-result marker and clean-process-exit authority. Syntax policy digest and semantics remain unchanged; suite policy/version digest changes.

## Validation

- `npm run build` — PASS (after correcting TypeScript narrowing in the parser).
- Focused: `node --test --test-concurrency=1 --test-name-pattern="repository suite|UNKNOWN retains|stage diagnostics|launcher process-result" dist/tests/verification-runner.test.js` — 7 passed, 0 failed.
- Repair-1 behavioral focused: `node --test --test-concurrency=1 --test-name-pattern="production serial test runner|repository suite|UNKNOWN retains|stage diagnostics|launcher process-result" dist/tests/verification-runner.test.js` — 8 passed, 0 failed. Exercises actual helper success/order/argv, fail and unknown stop, post-await late pass becoming UNKNOWN, cumulative log overflow, and ordinal-65 execution despite telemetry cap.
- `npm test` — 74 passed, 0 failed, 0 skipped; includes build.
- `npm run validate` — PASS, “Foundation structure validation passed.”
- `node --check infra/verifier-isolation/run-repo-suite.js` — PASS.
- `node --check infra/verifier-isolation/suite-diagnostics.js` — PASS.
- `bash -n infra/verifier-isolation/launch-verifier.sh` — PASS.
- `git diff --check` — PASS.
- Independent source review of candidate `0b85d05c3c53c0d6667803078033a52dd190664d` returned `FIX` in `work/c3-memory-source-review.json`, requiring actual-loop behavior tests; repair 1 covers that finding. Controller must independently review the new exact candidate after freeze.

Exact candidate remains an uncommitted working tree based on the base SHA above; controller freezes the resulting commit/tree and performs the next independent review/runtime step. Real isolated cloud execution, cgroup memory, and whether the complete suite fits unchanged limits remain UNKNOWN. Prior UNKNOWN attempts remain untouched.
