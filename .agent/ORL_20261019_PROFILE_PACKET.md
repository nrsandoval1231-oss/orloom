# ORL-20261019-PROFILE — approved builder runtime profile propagation

State: READY. Controller selected one bounded repair after independent source inspection.
UTC dispatch start/finish and measured command durations are recorded in the completion
artifact. Exact controller planning start is UNKNOWN.
Repository: nrsandoval1231-oss/orloom. Local branch: fix/approved-worker-profile.
Base: PR32 head 6d9ded07088079da88ed0b43dbc1249e26aac2cd.

## Evidence and objective

`main.ts` supplies the trusted execution input profile to the reconciliation runtime,
but omits it from runtimeOptions passed into runApprovedDockerWorkerLane. That lane
constructs the runtime which actually checks out and executes the approved task.
The result is whole-tree admission and rejection of tracked init-secrets.sh despite
the PR32 projection repair. Propagate the validated optional profile consistently
to actual builder execution and reconciliation, and pin that composition with a
behavioral regression which fails before the fix.

## Ownership and exclusions

One Luna owns apps/worker/src/main.ts, at most one small worker composition helper
if needed for a meaningful test, and the focused test in tests/approved-worker-startup.test.ts
or a new tests/approved-worker-runtime-options.test.ts. Luna may add
.agent/ORL_20261019_PROFILE_COMPLETION.json and a short docs/validation/2026-10-19-approved-worker-profile.md.
Do not alter timeout policy, input limits, forbidden path/secret checks, credentials,
SQL or migrations, provider logic, startup defaults, Governor, delivery, UI, historical
evidence, canonical architecture/Finish Contract, or any other repository.
You are not alone in the workspace; preserve all other edits and coordinate rather
than revert them. The controller owns this packet, state and final delivery plan.

## Acceptance and validation

1. Runtime options for actual execution include only the already validated operator
profile when present; absent profile preserves whole-tree fail-closed behavior.
2. Prefer one shared immutable options snapshot for reconciliation and execution
so the two runtime constructions cannot diverge. No new activation/config bypass.
3. A meaningful composition test captures the actual execution options or uses the
shared production assembly; assert present and absent profile behavior. Demonstrate
the test fails against the pre-fix production assembly and passes with the repair.
Do not merely grep source or mirror a literal value in a test.
4. Focused regression, build, typecheck, validate, diff-check pass. Controller performs
final locked install/full Linux tests at the frozen commit and independent review.
5. Default startup remains disabled; no secret reads, provider calls, Docker/host mutation,
push, PR write, merge, deploy or spend. Tests use isolated fixtures only.

Retry budget: two materially distinct repairs. If a seam requires broader architecture,
return the evidence and proposed bounded alternative before expanding scope.
Handoff: changed files, regression RED/GREEN evidence, commands/exit codes,
UTC build/validation times, repair count, exact base, UNKNOWN live gates. Do not certify
your own result, commit final candidate, merge, or promote graph state.
