# Orloom work graph

Updated 2026-10-14. Canonical: [CANONICAL_HARNESS](../docs/architecture/CANONICAL_HARNESS.md). Product completion remains OPEN. Repair PR #18 is merged at `dca7ac78df8f1c26a7c5cd2e8c9cfcb904297c2c`, reviewed tree `89a4ce7510699f993ce807fc4fdd71d0dceb606a`. The worker source is a separate successor; see [worker validation](../docs/validation/2026-10-14-worker-composition.md).

| Node | State / next gate |
|---|---|
| Mission control | PR #1 merged at historical main `6110c692`; bounded source/actual PostgreSQL acceptance. Lease digest, policy-restart and aggregate-state repairs passed combined source regressions. |
| Consolidation | Seven repairs merged through PR #18 after independent review, 167 tests and clean-install validation. Original repair ledger retained unchanged. |
| DeepSeek broker | PR #2 broker/runtime/checkout source included in separate successor. Normal startup deliberately disabled; independent v2 source review accepted, 188/188 tests passed with zero skips/failures. Worker ledger governs this bounded acceptance. |
| Worker activation | Candidate-bundle importer, recovery strategy/checkpoint executor, cancellation propagation, exact-container reconciliation and conservative interrupted-spend/quarantine release OPEN. |
| Worker historical evidence | Preserve 40 original evidence blobs, three state archives and three historical checkpoint documents. Original controlled-provider proof does not certify this successor. |
| Jev/recovery, learning, scheduling | Source composed; negative-evidence freshness and cohort repairs passed combined source acceptance. Live Jev, genuine activation, holdout/baseline evaluation and comparable benefit OPEN. |
| Orloom CI | Historical actual full-suite `f6023ac` FAIL/271438 ms/zero certificates. Fixture repair is composed; authentic exact-candidate runsc full suite OPEN. |
| Local integration | Historical `2a02606` source and actual two-pool PostgreSQL replay accepted within retained scope. New candidate is not thereby certified. |
| Controller and delivery | Historical `0725fa2` policy composition and `f6023ac` delivery PostgreSQL proofs bounded. Combined live PostgreSQL and deployment gates OPEN. |
| Reserved remote upload | `954622e` historical source/ref-replay proof; secure App/R2 configuration and real credentialed publication OPEN. |
| Living Loom | Controlled source/browser evidence exists; certificate-digest closure repair passed combined source acceptance. Canonical five-sector/source-inspection interactions and live-builder display remain incomplete. |
| Packaging / fixture throughput | Docker helper-source repair passed source regression; clean image build still OPEN. Historical `e078a51` 151-test/14-gate source checkpoint is not the new result or Linux isolation proof. |
| Evidence preservation | PR #14's 95 original evidence blobs and two historical state files, plus PR #15's two repair records and two historical state/manifest blobs, are preserved. All 15 PR #3–17 trees have no absent original paths after the 97 evidence additions. Historical records do not certify the containing commit. |
| Cloud end-to-end | Secure credentials, live workers, authentic verification, operational recovery, deployed campaign and measured learning gains OPEN. |

Direction: preserve source and evidence; validate/review one coherent candidate; perform authorized PR cleanup only after inclusion and acceptance are established. The owner's latest direction supersedes the earlier blanket no-merge restriction. PR #2 cleanup requires reviewed source/evidence inclusion and publication-tree verification; it does not authorize runtime activation. No GitHub Actions CI, competing broker/scheduler, automatic UNKNOWN replay or newly implied paid-host/provider authority.


Foundation progression: [acceptance checklist and next-step map](../docs/FOUNDATION_STATUS.md). Candidate admission remains upcoming in this checkpoint; no broad architecture rewrite or live activation is implied.
