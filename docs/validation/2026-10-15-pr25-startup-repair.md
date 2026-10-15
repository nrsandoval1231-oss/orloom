# PR #25 startup configuration review repair

Repair base: `8c25eeaf04e5b6d9a9744767d0fe73c6d22f31a4`. The [exact-head review](https://github.com/nrsandoval1231-oss/orloom/pull/25#pullrequestreview-5536934603) found two reproduced blockers missed by the earlier bounded source review. That prior PASS does not establish acceptance of this repair head; fresh independent review remains required. No review thread is resolved by the builder.

P1: the factory counted blank `.env.example` fields and unrelated R2 configuration as verifier activation. Tests added before implementation reproduce the factory failure and the actual child control-plane process exiting before its local UI listens. Activation now requires a nonempty verifier/admission-specific setting; the blank template, whitespace and R2-only configuration leave verification disabled. Once requested, incomplete/invalid verification still fails closed.

P2: the factory required raw R2 secret environment values despite supported `_FILE` configuration. It now reuses the existing protected `readSecret` helper from controller authority, including private regular owned bounded file checks and strict file precedence. Synthetic-file tests construct the admitting runner without raw credential values; an invalid configured file rejects instead of falling back to a raw value. Errors contain field names, not secret content or file paths. No real credentials are loaded by the tests and no adapter request occurs.

Evidence under [composition evidence](2026-10-15-composition/):

- `review-repair-red.txt`: build succeeds, both new factory regressions fail before implementation (4 pass / 2 fail).
- `local-template-startup-red.txt`: the real local entrypoint exits 1 with verifier configuration failure before serving the UI.
- `review-repair-green.txt`: focused configuration suite 6/6 passes after repair.
- `local-template-startup-green.txt`: child process serves the local UI from the blank template plus synthetic owner token; response states execution disabled.
- `repair-build.txt`, `repair-typecheck.txt`, `repair-validate.txt`: final source gates exit 0.
- `repair-postgres.txt`: actual fresh local PostgreSQL two-pool composition proof PASS; runtime observations are controlled, no live provider/runsc claim.
- `repair-linux-suite.txt`: authoritative final serial Linux result for this repair.
- `repair-source-manifest.json`: exact source manifest for the repaired candidate; checked unchanged after the suite.

Operational boundaries remain unchanged: normal worker main disabled, no live provider calls, credential provisioning, external target repository, deployment, merge or security/network changes. The follow-on explicit-config startup implementation proceeds separately on a stacked branch after this repair is pushed, preserving this exact head for independent re-review.

Final repair gates: build/typecheck/validate exit 0; Linux Node 24.22.0 serial suite 290 total / 288 pass / zero fail/cancelled / two existing skips, 123782.875745 ms. The actual PostgreSQL proof passes. All 127 source-manifest entries match after the suite. The full review comments were read and both failures were independently reproduced; no thread was resolved and fresh external review remains pending.
