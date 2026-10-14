# Slice 1b validation — durable authenticated owner cancellation

Recorded 2026-10-14. Branch `slice/01-runtime-identity-cancellation`, parent commit `9bd81ac` (Slice 1a), base `86a972300708f9bc05f557c5c09efd1c0f7e2ba6`.

## Scope

Slice 1 was split (see the [Slice 1a record](2026-10-14-slice1a-runtime-intent.md)). Slice 1a persisted controller-owned runtime intent. **Slice 1b** adds the other half: a durable, owner-authenticated cancellation request that fences stale work before any interruption is requested.

Deliberately **not** in scope: propagating cancellation to a running worker, proving a container is absent, releasing capacity on a controller-owned proof, or any spend refund. Those are Slice 2.

## Implementation

| File | Change |
|---|---|
| `db/migrations/009_worker_runtime.sql` | new, idempotent: `controller_run_id`/`runtime_required` columns, re-created mission/slice status constraints including `cancelling`/`cancelled`/`cancel_requested`, `mission_slices_check` keyed on `(status IN ('running','cancel_requested'))` so a fenced slice **retains its lease proof**, and `mission_cancellations` |
| `packages/contracts/src/mission.ts` | status unions extended; optional `MissionStore.requestCancel?` / `cancellationStatus?` |
| `packages/contracts/src/sql-mission-store.ts` | `requestCancel`, `cancellationStatus`, and the fences below |
| `packages/contracts/src/memory-mission-store.ts` | equivalent semantics (not a stub), so local mode matches cloud mode |
| `packages/contracts/src/postgres-store.ts` | 009 wired like 001–008 |
| `packages/governor/src/governor.ts` | `MissionGovernor.requestCancel`/`cancellationStatus` seam, mirroring `approve()`; the HTTP layer never calls the store directly |
| `apps/control-plane/src/server.ts` | `POST /api/missions/{id}/cancel` (owner session, strict body, 202/400/409/503) and `GET /api/missions/{id}/cancellation` (owner). No worker-facing route |
| `db/migrations/005_learning.sql` | **pre-existing defect fixed**: the recovery-binding constraint was added without `DROP CONSTRAINT IF EXISTS`, so the second startup failed (see D1) |
| `tests/runtime-cancellation.test.ts` | new, 15 tests |

### The fence

`requestCancel` takes `mission_governor_lock` `FOR UPDATE`, locks the mission row, records the request durably, and only then moves `running` slices to `cancel_requested` **without clearing `lease_token_hash`/`capability_hash`/`lease_expires_at`** — clearing them would silently refund reserved spend, and every productive lease operation (`withLease`, `recordProgress`, recovery) still requires `status='running'`, so the retained proof grants no new authority. Lease-less slices become durable tombstones. `claim` excludes missions that are `cancelling`/`cancelled`, and the free-slot and active-scope predicates count `cancel_requested`, so a fenced lease keeps its slot. Integration and delivery intents, `claimDeliveryEffect`, and `awaitingVerification` are all fenced. `expire()` only touches `running`, and `refreshMissionStatus` refuses to clear `cancelling`/`cancelled`, so reconciliation cannot resurrect a cancellation. `cancellationStatus` re-derives epoch and both token hashes from the durable row and returns `false` — never a leaky error — for a stale epoch, foreign token, or expired lease. `claim` and `requestCancel` both take the governor lock as the first statement of a single transaction, so they serialize.

## Checks and results

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | — |
| Build | `npm run build` | 0 | — |
| Validation | `npm run validate` | 0 | passed |
| Focused | `node --test dist/tests/runtime-cancellation.test.js` | 0 | 15 tests, 15 pass, 0 fail |
| Migration probe | apply all 9 migrations 3× to one database | — | **3× clean** (was: run 2 and 3 failed at 005) |
| Full suite | `npm test` | 1 | **244 tests, 230 pass, 13 fail, 1 skipped, 70193.99 ms** |

244 = 229 (Slice 1a state) + 15; 230 = 215 + 15. The 13 failures are unchanged from the baseline: exactly `tests/candidate-admission.test.ts`, refused by the documented Linux/POSIX private-root guard. The skip is the journal test's Windows-symlink subtest. No file-level failures. Worktree clean after.

## Independent adversarial review

A reviewer with no builder context reproduced the suite (240/226/13/1 at that time) and returned **"gate NOT cleanly met"**. It could not falsify the literal worker clause, but found real defects. Disposition:

| Finding | Disposition |
|---|---|
| **D1 [HIGH] pre-existing**: `005_learning.sql` added a constraint without `DROP … IF EXISTS`, and because `PostgresJobStore.connect()` re-executes every migration at startup, a real second startup failed and `restart: unless-stopped` would crash-loop. This defeated the slice's restart gate | **FIXED** (one idempotency guard). Regression added: `every migration is idempotent under a real startup re-execution` applies the whole directory three times. The probe confirms 3× clean. |
| **D2 [MED-HIGH] introduced by this slice**: cancelling an already-`verified` mission set it to `cancelling` and nothing could ever clear it, destroying the terminal signal and blocking delivery | **FIXED**: `requestCancel` now refuses a `verified` mission (both stores), and `verified` was removed from the "uncertain" set. Regression added. |
| **D3 [MED]**: the source comment claimed cancellation releases no capacity slot, but `blocked → cancelled` does release one while spend is retained | **FIXED**: the comment now states exactly that behaviour, and a regression pins slot accounting and the unchanged reservation. |
| **D5 [LOW-MED]**: `owner_request_id` was globally `UNIQUE`, so reusing an id on another mission raised a raw constraint error → HTTP 500, and the memory store diverged | **FIXED**: global uniqueness dropped (the per-mission primary key already scopes it; the store refuses a competing id for the same mission). Regression added. |
| **D4 [MED]**: there is no worker-facing cancellation route, and `cancellationStatus` returns `false` once the retained lease expires, so the *signal* is time-limited while the *fence* is permanent | **Confirmed, recorded.** Implementing the interruption request is Slice 2. This record claims the fence, not the interruption. |
| **D6 [LOW]**: non-UUID mission ids on the new SQL routes raise a raw uuid cast error → 500 (the HTTP test uses the memory store) | **Confirmed, recorded** as a known gap; the same pre-existing pattern exists on `getMission`. |
| **D7 [LOW]**: `createVerificationAttempt`/`submitVerification` have no mission-status guard, so a verification attempt can still be created for a cancelled mission | **Confirmed, recorded.** It cannot reach `verified` (integration is fenced) and cannot release capacity. |
| **D8 [INFO]**: 009 ships `controller_run_id`/`runtime_required`, which are claim-scoped runtime columns | **Recorded**: retained because the fence accounts for them; the file comment now says so. |
| Test quality: the interleaved race genuinely interleaves, but the harness serializes transactions on one PGlite connection, so it would pass even without `FOR UPDATE`; the worker-assertion test does not cover `recordProgress` or the verification/delivery surfaces | **Confirmed.** The lock is verified by source reading as well; the uncovered surfaces are fenced by `status='running'` and are recorded. |
| Evidence record was not self-contained (`git diff` omitted new files) | **FIXED**: the retained `slice1b.diff` is generated from the staged tree and includes the new migration and test. |

The reviewer could not verify: live PostgreSQL (real row locks, `SKIP LOCKED`, true concurrency, uuid/unique errors, the second startup), Docker/runsc/Linux, provider or publication paths. All PGlite-based findings were reproduced; D1 was reproduced on PGlite and confirmed independently by the migration probe on this host.

## Gate coverage

| Slice 1 gate item | Status |
|---|---|
| Duplicate cancellation | Covered: same id idempotent, competing id refused, concurrent duplicates tested |
| Cancellation races | Covered: interleaved claim/cancel with a barrier; the governor lock serializes both orders; no double-booking or refund |
| Stale epochs | Covered: `cancellationStatus` false for a superseded epoch, wrong token, expired lease, or missing slice; worker terminal paths require `running` |
| Restart | Covered as source+fixture: durable cancellation survives a store restart, and every migration is idempotent under a 3× startup re-execution |
| No worker-supplied assertion can release capacity | Holds under review: every worker-reachable mutation requires `status='running'` or a non-cancelled mission, `reserved_cents` is only ever incremented anywhere in the codebase, and `expire()`/`refreshMissionStatus` cannot clear a cancellation |

## Evidence class

**Source and fixture/PGlite only.** Not exercised: actual PostgreSQL, Docker/runsc, Linux ownership/mode checks, live provider, worker cancellation propagation, or publication. No GitHub Actions, no new environment variables, no dependency changes, no edits to `docs/evidence/**` or `docs/validation/foundation-release/**`.

## Limitations and unresolved risks

1. **The fence exists; the interruption request does not.** Nothing polls `cancellationStatus` from a runtime, and a `cancel_requested` slice's lease expires without renewal, after which the poll returns `false` while the slice stays fenced. D4; Slice 2.
2. **Cancellation never completes for a mission with a live or unresolved slice.** `completed_at` is set only when nothing is uncertain; otherwise the mission stays `cancelling` until a controller-owned absence proof exists. Intended and conservative, but it means a cancelled mission is not terminal in this slice.
3. **D6**: non-UUID ids on the SQL cancellation routes surface as HTTP 500.
4. **D7**: verification-attempt creation is not mission-status fenced.
5. **Cross-host digest/`localeCompare` class (from the Slice 1a review) remains** in other packages; out of scope here.
6. **The interleaved race test cannot discriminate a missing `FOR UPDATE`** because the PGlite harness serializes transactions; the lock is verified by source reading only.
7. **No live PostgreSQL acceptance**, so real lock behaviour and the startup path are still fixture-level evidence.
