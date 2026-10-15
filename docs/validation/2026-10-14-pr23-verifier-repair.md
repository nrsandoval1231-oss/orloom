# PR23 verifier repair: commit-bound source validation

## Finding

The prior `verify-1c.mjs` loaded `dist/apps/worker/src/runtime-journal.js` and inspected `apps/worker/src/runtime-journal.ts` from the caller's working tree. That allowed stale or uncommitted files to influence a claimed committed-head verification. It also logged missing artifact manifests and continued, and the retained `verification-after.txt` says `10/10` while the associated manifest lists 11 artifacts.

## Repair contract

The verifier now takes a full source commit ID, verifies that ID, clones the repository without hardlinks into a fresh temporary checkout, detaches at the requested commit, and runs locked install, typecheck, build, validation, focused regressions, and the full suite only from that checkout. The focused set covers journal history/cap, runtime intent and identity, cancellation, claim regressions, and PGlite migration/mission behavior. The verifier refuses non-Linux execution and Node versions below 24.

Committed artifact manifests are mandatory. Missing manifests or blobs, malformed/duplicate/unsafe entries, empty manifests, and hash mismatches fail the run. The regression test demonstrates that a dirty worktree cannot alter the selected commit and that each integrity failure fails closed.

## Evidence chain

The source candidate S contains the verifier, regression test, this explanation, and a committed SHA-256 manifest for these source artifacts. The existing Slice 1c artifact manifest is updated only for the verifier blob; its retained Windows logs remain byte-for-byte unchanged. Its earlier `verification-after.txt` output remains historical and is superseded by the separate PR23 receipt.

The Linux run writes command logs and a source-verification record outside its isolated checkout. These are committed in evidence candidate E and bound by an E-local manifest. The receipt candidate R names S and E, verifies their committed artifacts by Git blob bytes, and states its own explicit manifest exclusions. No receipt claims to authenticate its own future contents.

## Acceptance boundary

This evidence establishes exact-commit source/build/test behavior on the recorded native Linux host. It does not establish runsc isolation, actual PostgreSQL behavior, live providers, cancellation propagation beyond source tests, deployment, or product completion. Runtime activation and all broader finish-contract gates remain open.
