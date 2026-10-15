# PR26 exact-head restart repair

Owner-directed 2026-10-15 follow-up to independent review `5537513332` of head `a8644549b83826f2112bb8f5ad21279c5122aa23`, tree `7111e17a7c6e086c8ef50a45ecaf03bc3451e94f`. PR25 `27b786b140a2f0f73141aa60175b939b8f6ba605` passed independent re-review and stays unchanged. No merge, thread resolution, live provider, credential, deployment or host changes.

Repair the three reproduced restart defects without weakening existing fences:

1. Normal completed runtime ABSENT evidence must pass the actual retained-journal callback so exact certificates can pause for review and later integrate/deliver. Validate identity/container/binding/history; unknown or malformed runtime proof remains quarantined. Normal runtime absence never settles cancellation, changes slice state, releases capacity or refunds spend. Later genuine cancellation must still settle from retained proof.
2. A cancelled claimed lease with no registered runtime must invoke the existing atomic pre-runtime settlement fence on restart. Refresh durable state; registered intent/binding still quarantines. Never repeat builder/provider execution or refund reserved spend.
3. Exact target verification eligibility must be queried by mission/slice/current epoch, preserving existing terminal-attempt and dispatch-failure guards. A global capped queue cannot decide one-target recovery eligibility.

Bounded ownership: store/contract implementation and eligibility tests; service/main/shared callback composition and actual journal/store restart regressions; independent read-only source reviewer. Controller retains fail-before output, runs final exact-source gates/real PostgreSQL and publishes the repair. No competing builds or concurrent edits to the same module.

Acceptance: exact fail-before/pass-after reproductions including actual production reconciliation callback, memory and SQL no-runtime cancellation, >100 unrelated candidates, stale epoch/terminal attempt/dispatch guards, changed/UNKNOWN absence refusal and conservative budget/capacity behavior. Build/typecheck/validate, full serial Linux suite, actual isolated PostgreSQL, final source/executed-build hashes and independent source re-review. Earlier bounded source PASS is superseded by the external findings; new exact-head external review remains required after push.
