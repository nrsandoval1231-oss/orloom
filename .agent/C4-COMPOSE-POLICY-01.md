# C4-COMPOSE-POLICY-01

## Objective and authority

Correct the startup-shaped local integration boundary from base `3962ee0bd3c98eca010108a81a2bef4b9ed2559d` on `feat/controller-composition`. The independent review `../controller-composition-review-3962ee0.json` found that the Governor compared the full-suite verifier digest to the lease/operator allowed-check-list digest. The canonical direction is `../controller-policy-domain-direction.md`. Keep those digest domains separate.

Implementation ownership: `packages/governor/src/governor.ts`, `packages/contracts/src/mission.ts`, `packages/contracts/src/sql-mission-store.ts`, `tests/startup-policy-flow.test.ts`, and focused fixture alignment in `tests/local-integration.test.ts`, `tests/integration-replay-race.test.ts`, `tests/delivery-c4-flow.test.ts`, and `tests/delivery-effects.test.ts`. The SQL getter addition was explicitly authorized by root: expose the existing attempt `lease_policy_digest`; do not add a migration or rewrite existing digests. Root owns current state, manifest, final gates and independent review.

## Required behavior

- `loadConfig` continues deriving and using the operator allowed-check-list digest for claim/lease and `verification_attempts.lease_policy_digest`.
- The active trusted coordinator exposes an immutable copied binding for allowed check IDs, suite policy digest/version, image digest, verifier identity and lease digest.
- Governor requires its coordinator allowed list and lease digest to match the current operator config. Certificates/requests and SQL integration intent/finalization use the full-suite verifier digest.
- First integration checks the attempt's stored lease digest, receipt/request/certificate correspondence and verifier image/version/identity. Final SQL integration locking rechecks the attempt lease digest against the leased slice value.
- Exact completed replay rereads the integrated certificate and final PASS attempt, validates the coordinator's current verifier binding and stored original lease digest, re-verifies retained artifact bytes through the existing runner path, and preserves plan, review, candidate/tree, request, ref, UNKNOWN and certificate digest fences. Awaiting-only `getCertificate` remains unchanged.
- The startup-shaped PGlite/bare-Git acceptance flow derives actual config and suite policy, performs a trusted final certificate, first integration and exact replay, and tests mismatched config/check list, changed policy/version/image, missing receipt/certificate, moved ref, UNKNOWN intent and post-intent lease-digest mutation. No provider is contacted.

## Validation and limits

Run `npm run build`, `npm run typecheck`, focused startup/local integration/replay/delivery tests, and `git diff --check`. The test exercises PGlite and disposable real bare Git with controlled verifier/review fixtures. It is not real PostgreSQL multi-connection, authentic verifier execution, external GitHub/R2, cloud startup, deployment, or operational acceptance. No commit, push, merge, host, provider or external action is authorized.
