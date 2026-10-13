# C4-REPLAY-RACE-01 — completed integration replay reconciliation

**Objective/base.** Correct the independently confirmed C4 exact-request replay race on branch `fix/integration-replay-race`, base `03795427a22fb21eb3890e5ae8e7f7c2c5071ae9`. The retained local PostgreSQL run applied migrations and passed ordinary integration, then failed concurrent post-CAS replay because a finalized slice no longer exposes certificates through the awaiting-only `getCertificate` method.

**Direction/authority.** Follow `work/c4-race-direction.md`: keep first-time admission closed on missing, stale, conflicting, UNKNOWN, moved-ref, review, or policy evidence. Reconcile a completed exact replay only through fresh durable intent/slice checks, fixed-ref and tree readback, digest-bound retained review validation, then the existing locked SQL `finishIntegrationIntent` fence including persisted final PASS certificate and receipt validation. Never widen public `getCertificate`; replay must not CAS, insert another event, rewrite state, or release children twice.

**Owned files.** `packages/governor/src/governor.ts`, `packages/contracts/src/sql-mission-store.ts`, and only if required the integration contract in `packages/contracts/src/mission.ts`; `tests/local-integration.test.ts` and/or a focused new replay-race test; this packet and `C4-REPLAY-RACE-01-COMPLETION.json`.

**Exclusions.** No C4 proof helpers, `docs/evidence/c4-postgres`, source delivery/PR2, worker/provider/runtime/credential/dependency changes, migrations, or external/host operations. Do not integrate, commit, push, merge, deploy, or run the real PostgreSQL helper. Root owns the next actual PostgreSQL replay attempt after source review.

**Acceptance.** Deterministic PGlite barriers pause a second exact request after its pending-intent read and at the awaiting-slice, initial-certificate, final-certificate, and SQL-finalization gates while the first request commits. Both calls return the same verified slice; the integration ref advances once, exactly one integrated event exists, and dependency release occurs once. Negative replay identity changes, missing/changed certificates or receipts, changed review/tree/plan/policy, UNKNOWN intent, and moved ref remain closed without additional event or dependent release. SQL replay validation runs under the existing Governor lock and is read-only when already integrated.

**Validation.** `npm run build` PASS; `npm run typecheck` PASS; `node --test dist/tests/integration-replay-race.test.js` PASS (five barrier points plus negative replay mutations); `node --test dist/tests/local-integration.test.js` PASS; `git diff --check` PASS. Negative cases include conflicting review digest, altered persisted receipt, changed approved plan, changed policy, changed durable tree, moved fixed ref, and UNKNOWN intent. Root owns complete source gates, independent review and real PostgreSQL/two-pool verification.

**Handoff boundary.** Source/test repair is ready for independent review only. The real PostgreSQL/two-pool replay has not been rerun; no operational or completion claim is made.

**Retry/checkpoint.** Two bounded repairs. Preserve the three retained runtime failures and all existing source. Stop for architecture uncertainty, any ambiguity that would permit a pending/moved/UNKNOWN request to succeed, or a public certificate-authority change.
