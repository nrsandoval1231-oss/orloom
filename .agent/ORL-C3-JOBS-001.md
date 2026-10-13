# ORL-C3-JOBS-001 - Single PGlite lifecycle

Status: READY for controller freeze and independent source review.
Node: ORL-C3-JOBS-001. Repository: `work/orloom-suite`.
Branch/base: `feat/trusted-verification-suite` at `7fb97aac17dd440ec6f64f3d38fe43e527b9ce79`.

## Objective and scope

Reuse one PGlite database and one application of `001_initial.sql` for the two existing jobs behaviors. Keep the lifecycle and invalid-status checks as separately named, awaited serial subtests, and close the database in `finally` around migration setup and both subtests.

Owned changes: `tests/jobs.test.ts`, this packet, and `.agent/ORL-C3-JOBS-001-COMPLETION.json`. No other source, migration, package, policy, resource-profile, suite-runner, broker, or authority changes. No external calls, commits, or pushes.

## Dependencies and invariants

Follows `.agent` current state and controller direction in `work/c3-jobs-repair-direction.json`. Preserve every existing assertion, retain no skips, and leave the historical manifest and prior UNKNOWN full-suite attempt unchanged. This is a lifecycle hypothesis only; it does not establish that PGlite caused the OOM or that full-suite acceptance is fixed.

## Validation and handoff

Focused validation passed on the current working tree: `npm run typecheck`, `npm run build`, and `node --test dist/tests/jobs.test.js`. The compiled test reports 3 tests (parent plus 2 subtests), 3 passed, 0 failed, 0 skipped. Exact SHA and newly generated source manifest are assigned by the controller after freeze. Controller must run the unchanged-profile focused diagnostic before considering a new full-suite attempt; this builder did not run a full suite or cloud/provider probe.

See completion record for commands, exit codes, UTC timing, and limitations.
