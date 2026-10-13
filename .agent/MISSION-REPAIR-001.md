# ORL-005A bounded repair 1

Base: main 41643d8b210c98dd5b8b870e79f5a9902c83882b on feat/canonical-mission-execution. Candidate before repair: manifest 6a2d67c1cf82ba242a819bd82db4755ec00d9a376a304fd231c4c3e09c2eb15b. Preserve the independent FIX review and prior manifest/completion under .agent/archive/ before replacing current artifacts.

Owner: mission_builder. Same A file ownership; additionally .gitattributes (preserve infra/worker-isolation/** -text) and new lease reconciliation helper/tests if necessary. No worker, reference, production, infrastructure, Git, or controller state edits. Other agents are active; do not revert their changes.

Repair the independent review findings: distinguish ordinary dependency waiting from unresolved worker BLOCKED/UNKNOWN quarantine; do not let waiting children prevent ready parents with overlapping ownership from claiming; aggregate mission status correctly while waiting for verification; automatically and durably reconcile expired running leases to UNKNOWN without replay, reservation release, or slot/scope reuse; case-fold owner/repository identity for cross-mission scope checks. Follow the finalized MISSION-REVIEW.json findings, including precise edge cases.

Acceptance: regression tests for overlapping parent/child claims, candidate aggregate state with waiting dependencies, real automatic expiry/restart behavior, quarantine retention, and same-repository mixed-case conflict. No certification or integration activation. Keep budgets conservative. Reconciler errors must not leak secrets or crash silently; lifecycle must stop on service shutdown. Bound each reconciliation batch.

Normalize the 21 scoped text candidate files and repair files to LF before freezing. Add default * text=auto eol=lf to .gitattributes while preserving audited infra bytes. Regenerate raw SHA256 source manifest only after all source/doc/test edits and required gates. No source mutation after freeze. Record UTC repair start/finish, commands/exits, count=1, model/lane, and UNKNOWN token usage; do not invent metrics.

Run focused regressions, then full typecheck/test/build/validate/diff checks. Hand frozen source to hostinger_builder for independent PostgreSQL proof and canonical_audit for re-review. No commit/push/deploy by builder. A second materially different repair is the remaining default repair budget if required.
