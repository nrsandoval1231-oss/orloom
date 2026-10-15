# PR26 lifecycle correction

Full protected-boundary repair, READY under explicit owner delegation 2026-10-15. Branch `feat/explicit-approved-worker-startup`, isolated checkout `orloom-pr26-lifecycle`, exact starting head `9347c1701c8f18ea7e5b037695b88f584a747473`. UI successor checkout/branch is separate and must not be modified here. PR25 merged separately; reviewer owns all merges.

Formal correction: https://github.com/nrsandoval1231-oss/orloom/pull/26#pullrequestreview-5538203597 supersedes the earlier PASS. P1: abort inside verification still proceeds to certified preparation, integration and delivery. P2: accepted long-lived manifest overflows Node's timer and expires immediately.

Finish contract: explicit stop/expiry fences before each new effect through verification, preparation, integration and each external delivery write; abort/expiry during an already-started ambiguous effect retains existing UNKNOWN/idempotency semantics, never claims delivered or starts another stage. Owner cancellation must use durable state and existing atomic authority. No retry or refund. Validate adjacent boundaries including pre-aborted, abort during verify/prepare/integration/delivery stages, cancellation before next stage, expiry during work, valid long deadlines, already-expired deadlines and timer cleanup. Default startup remains disabled.

Test-first workflow: assigned workers write tests and capture actual baseline behavioral failures BEFORE product edits, then obtain controller build coordination. Preserve rejected attempts, exact source/build hashes, synthetic fixture limits and actual PostgreSQL where relevant. Final build/typecheck/validate/full Linux suite, independent Sol review and exact-head external review. No paid providers/credentials/runtime activation, host mutations, deployment or merge. Host preparation is separately authorized but paused until correctness is restored.

Source boundaries remain the existing worker service/startup, Governor/integration/delivery authorities as required; no parallel authority, schema rewrite or canonical UI changes. Worker reports cannot certify completion. Controller owns publication, artifacts and evidence ledger.
