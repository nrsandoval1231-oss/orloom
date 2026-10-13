# ORL-C2-001 completion handoff

Status: implementation complete; controller freeze and independent source review pending. This is source/test evidence only.

## Identity

- Worktree: `work/orloom-scheduling`, branch `feat/adaptive-scheduling`.
- Base and current `HEAD`: `7a6165e3e9ce143e13aaab3b9e5b735c8eb35cdc`.
- Candidate remains uncommitted; no frozen candidate SHA was created. The controller must freeze the final tree before exact-candidate gates/review.
- PR #2 (`8bbcfffbf631e5ad2972e34b41284198afc566e2`) and its broker were not touched.

## Changes

- Extended the existing Governor/store claim path with a bounded advisory snapshot, stable deterministic rank (longest remaining DAG path in slice-count units, narrower known scope breadth/wildcard risk, lower cost, then lexical identity), optional one-shot finite-choice adapter, and a fresh transactional eligibility/snapshot-digest fence. The existing lease, capacity-slot, reservation, scope, dependency and budget commit path remains authoritative.
- Kept production behavior deterministic unless an adapter is explicitly injected. Jev receives at most 32 opaque candidate labels and 16 KiB of repository/plan/dependency-depth/budget/scope-risk and exact promoted-lesson provenance metadata; it receives no source/evidence body. Error/invalid/stale provenance is retained on the claim event, including whether dispatch may have occurred.
- Added memory and PGlite behavioral coverage for critical path and stable rank, 0/1/>32 choices, adapter error fallback, concurrent claims, stale lesson withdrawal, bounded-context rejection, exact lesson provenance, capacity/budget reservation behavior, and the unchanged HTTP worker lease envelope.
- Updated two SQL mission fixtures to initialize migrations 004 and 005, required by the now-read trusted lesson provenance column.

Changed files:

`apps/control-plane/src/server.ts`; `packages/contracts/src/memory-mission-store.ts`; `packages/contracts/src/mission.ts`; `packages/contracts/src/scheduling.ts`; `packages/contracts/src/sql-mission-store.ts`; `packages/governor/src/governor.ts`; `packages/judgment/src/jev-adapter.ts`; `tests/missions.test.ts`; `tests/scheduling.test.ts`; `.agent/ORL-C2-001.md`; `.agent/ORL-C2-001-COMPLETION.md`.

## Validation

- `npm ci --ignore-scripts` — exit 0; lockfile unchanged.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `node --test dist/tests/scheduling.test.js dist/tests/missions.test.js dist/tests/mission-http.test.js` — exit 0, 16/16 passed.
- `npm test` — exit 0, 87/87 passed on final source state.
- `npm run validate` — exit 0, “Foundation structure validation passed.”
- `git diff --check` — exit 0.
- Earlier validation findings were repaired: two old SQL fixtures lacked migration 005, and one test expectation was updated for the added sanitized provenance fields. No remaining failures.

## Boundaries and unknowns

- No real PostgreSQL multi-connection proof, live Jev call, provider spend, host action, deployment, or measured scheduling benefit was attempted. Fixtures establish source behavior only.
- No package/lock, migration, worker protocol, broker, or production default changes. No commit, push, merge or deployment.
- Exact source review and final-candidate gates remain with the controller.
- Timing/config telemetry: finish `2026-10-13 14:01:49 UTC`; start timestamp was not captured (first workspace observation was about `08:49 CDT`, so elapsed is approximately 13 minutes, precision UNKNOWN). Planning/build/validation phase durations, model/config identity and token counts were not measured and remain UNKNOWN. Single primary-builder lane; two localized validation corrections; independent audit pending.

## Repair 1 — C2-F1 through C2-F3

- Exact repair base/HEAD at handoff: `8f2d27ef3d12b9c0318faf1314493c3b2f03697b`; worktree changes are uncommitted and the controller must freeze this exact source state before final gates/review.
- Preserved the original FIX review `work/c2-source-review-8f2d27e.json` and all previous completion evidence. No migrations, dependencies, worker protocol, provider configuration, production adapter injection, PR #2, or external/provider actions were added.
- Scheduling advice now carries a UUID decision identity, exact snapshot digest, trusted-check and recovery-policy digests, conservative `dispatchMayHaveOccurred: true`, validated candidate only, actual adapter model ID, and measured token usage only when valid (otherwise null/UNKNOWN). No cost or raw response is persisted. The Jev adapter returns its validated model and measured usage with the selected candidate.
- The existing `mission_events` model now records bounded `scheduling.decision` events before possible dispatch, after advice resolution, and after a fresh claim returns no lease. The no-lease record uses the original snapshot mission anchor, so a vanished fresh eligible set does not erase the attempted decision. SQL insertion fails closed for a missing mission.
- Focused coverage includes selected result provenance, adapter model/usage propagation, invalid returned label with deterministic fallback, actual bounded JevClient timeout via a never-settling injected transport, oversized context before transport, stale lesson withdrawal through the full Governor/SQL path, capacity loss/no-lease event with no reservation, and simultaneous full Governor/PGlite claims with distinct slices and slots. The existing HTTP lease envelope test also passes. Existing exact promoted-lesson filtering assertions remain.
- Validation on this repair candidate: `npm run typecheck` exit 0; `npm run build` exit 0; `node --test dist/tests/scheduling.test.js dist/tests/mission-http.test.js` exit 0 (8/8 passed); `git diff --check` exit 0. The root controller will run the mandatory final gates on the frozen candidate; full suite not repeated in this repair lane.
- One initial focused PGlite race assertion failed because a previously issued lease left only one enabled free slot; the fixture was corrected to provide two free slots and exclude the intentionally no-grant mission's ready slices before the concurrency case. The rerun passed.
- Validation began after the earlier worktree observation; repair start timestamp/duration, phase durations, model/config telemetry, and token counts were not measured and remain UNKNOWN. Handoff recorded at `2026-10-13 14:23:37 UTC`.
- Still open: source review of this new exact candidate, controller final gates, real PostgreSQL multi-connection proof, live Jev/cost/provider validation, runtime/host integration, and measured scheduling benefit. Fixture tests do not constitute runtime verification.

## Repair 1 acceptance addendum — remaining F3 cases

- Preserved the Repair 1 handoff and first independent FIX record. No production source changes were needed for this test-only addendum.
- Expanded `tests/scheduling.test.ts` using the same PGlite database and full `MissionGovernor -> SqlMissionStore.claim()` path. Added fresh-state cases for mission budget dropping below slice cost (no lease/reservation, durable no_lease event), an UNKNOWN same-repository scope becoming overlapping after advice (advice falls back to the non-conflicting slice, UNKNOWN row remains quarantined), dependency parent changing from verified to UNKNOWN (dependent slice is not leased, alternate is), plan digest changing during advice (preferred slice is ignored and deterministic candidate is leased), and slot evidence expiring during advice (no lease/reservation and durable no_lease record).
- Corrected PGlite concurrency selection to choose an identity actually present in each exact snapshot and isolated the two-ready-slice scenario; asserts two distinct leases, two distinct capacity slots, two claim events and exactly 200 reserved cents. Added memory coverage proving a failed durable pre-dispatch event write prevents adapter dispatch and preserves deterministic claim behavior.
- Test-fixture failures encountered and corrected: status transitions were amended to satisfy existing lease-state constraints; the budget mutation now uses a valid positive value below slice cost; concurrent setup releases an earlier verified slot and quarantines unrelated ready slices. The final rerun is green.
- Exact source HEAD remains base `8f2d27ef3d12b9c0318faf1314493c3b2f03697b`; final candidate is uncommitted. Validation: `npm run typecheck` exit 0; `npm run build` exit 0; `node --test dist/tests/scheduling.test.js dist/tests/mission-http.test.js` exit 0 (9/9 passed); `git diff --check` exit 0. No full suite repeated; parent runs exact-candidate final gates.
- Fixture evidence remains source-only. This is not real PostgreSQL multi-connection, provider, runtime, host, or scheduling-benefit verification. Handoff recorded at `2026-10-13 14:28:18 UTC`; phase durations and token/config telemetry remain UNKNOWN.
