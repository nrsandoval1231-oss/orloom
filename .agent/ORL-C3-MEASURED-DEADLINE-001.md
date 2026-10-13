# ORL-C3-MEASURED-DEADLINE-001 - Finite suite deadline trial

Status: implementation complete; pending controller freeze and independent source review.
Repository: `work/orloom-suite`; branch `feat/trusted-verification-suite`.
Base SHA: `41fd3a225e805e8fe8a965fef7bb476a5e103900` (verified clean at dispatch).

## Objective and evidence basis

Bind the suite-only trial timer chain 360,000 / 390,000 / 405,000 / 420,000 ms to policy, image runner, launcher, diagnostics and host parser. Preserve the separate syntax policy and 2 GiB profile. Prior actual 2 GiB attempt `770b1ae5-84cf-4c33-962b-dbfc701f056a` remains UNKNOWN with zero certificates: ten test files completed, peak sampled memory was 1,278,328,832 bytes with no OOM event, then the 180-second image limit expired during file 11. This evidence supports a deadline trial only; it does not establish completion or a runtime guarantee.

The unchanged 120-second UNKNOWN settlement puts the maximum attempt plus settlement at 540 seconds, below the unchanged 600-second request maximum. No timeout is worker-selectable. Diagnostics are advisory only and now use protocol v4, with stage and file elapsed caps both at 360,000 ms; frame count, bytes, ordinal, and filename caps are unchanged.

## Files changed

- `packages/verification/src/policy.ts`: suite manifest/version advanced to deadline-360s v5; suite timer chain and diagnostic binding updated. Syntax policy unchanged.
- `infra/verifier-isolation/run-repo-suite.js`: suite budget 360,000 ms.
- `infra/verifier-isolation/launch-verifier.sh`: suite attach budget 390 s, retaining two-second kill grace and syntax 60 s.
- `infra/verifier-isolation/suite-diagnostics.js`: v4 prefix/version and 360,000 ms bounds.
- `packages/verification/src/runsc-launcher.ts`: accepts only v4 diagnostics and clamps elapsed time at 360,000 ms.
- `tests/verification-runner.test.ts`: checks exact policy timers/digest, the 540-second outer bound, syntax invariants, runner/attach timers, executable timeout UNKNOWN behavior, max elapsed acceptance/rejection, and old-protocol rejection.
- `docs/verification.md`, `infra/verifier-isolation/README.md`: describe the versioned trial allocation and unchanged settlement.
- This packet and `.agent/ORL-C3-MEASURED-DEADLINE-001-COMPLETION.json`.

No stage runner, test corpus, dependencies, schema, certification/Governor, broker, PR #2, host settings, provider resources, or prior evidence was changed. Controller-owned runtime acceptance helpers and evidence are separate; controller has identified their 420-second observation bound and 360-second hang fixture update. No host/runtime attempt was performed here.

## Validation and handoff

Passed: `npm run typecheck`; `npm run build`; `node --test dist/tests/verification-runner.test.js` (14 pass, 0 fail, 0 skipped); `node --check infra/verifier-isolation/run-repo-suite.js`; `node --check infra/verifier-isolation/suite-diagnostics.js`; `bash -n infra/verifier-isolation/launch-verifier.sh`; `git diff --check`.

The new default suite policy version is `orloom.node-repo-suite.v5`, manifest version `node-repo-suite-v1.deadline.serial-tests.diagnostics-v4.resources-2g.deadline-360s`, digest `5b57ce4b9ee14cf42300ee0773d73125a2aaa0519e70c0b5a4cb956f90f304ed`. Syntax policy remains at 60,000 ms and digest `e94f014eafb1763402f210b4bd0218f3807aa9e6ca74ccaeda988661670c5cbe`. Candidate SHA and source manifest are pending controller freeze and regeneration from staged Git LF. Controller owns mandatory full gates, integrated-source independent review, helper review, and any conditional proof.
