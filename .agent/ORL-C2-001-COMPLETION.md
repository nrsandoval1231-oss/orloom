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
