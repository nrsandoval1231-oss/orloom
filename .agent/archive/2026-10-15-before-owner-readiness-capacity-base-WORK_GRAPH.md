LATEST OVERRIDE: review 5538859140 supersedes acceptance of 2dc1876 for the verifier capacity race. Current READY packet: PR26_CAPACITY_PACKET.md. Atomic reservation before await, finally release and deadline recheck pass focused 28/28, build/typecheck/validate and independent source review. Full suite and publication-head external review remain pending. UI publication is HOLD; host preparation has separate private evidence. Statements below are historical acceptance.

LATEST OVERRIDE — PR26 lifecycle correction (2026-10-15): external review 5538203597 supersedes prior acceptance of 9347c17. PR25 is now merged on main e7e5119865144c525132b6ab04fa8aa2c371e14c; PR26 targets main and remains unmerged. Lifecycle/expiry repair and adjacent inner dispatch/finalization/UNKNOWN fences pass final build/typecheck/validate, Linux 363 total/361 pass/zero failures/two existing skips, actual PostgreSQL lifecycle/restart and bounded independent source review. Exact-head external review remains OPEN. See docs/validation/2026-10-15-pr26-lifecycle.md. Earlier PASS statements below are historical and do not accept this candidate. Host preparation is paused; saved UI successor is held. No live provider/verifier/GitHub delivery proof, deployment or host mutation is claimed.
# Orloom work graph

Updated 2026-10-14. Canonical: [CANONICAL_HARNESS](../docs/architecture/CANONICAL_HARNESS.md). Product completion remains OPEN. Repair PR #18 is merged at `dca7ac78df8f1c26a7c5cd2e8c9cfcb904297c2c`, reviewed tree `89a4ce7510699f993ce807fc4fdd71d0dceb606a`. Worker PR #19 is merged at `d99b26ec828495b7648179a144bc4e38f5c5f80c`, exact reviewed tree `6f538b0690f673d49752fa90bb1b123762b97cfe`; see [worker validation](../docs/validation/2026-10-14-worker-composition.md).

| Node | State / next gate |
|---|---|
| Mission control | PR #1 merged at historical main `6110c692`; bounded source/actual PostgreSQL acceptance. Lease digest, policy-restart and aggregate-state repairs passed combined source regressions. |
| Consolidation | Seven repairs merged through PR #18 after independent review, 167 tests and clean-install validation. Original repair ledger retained unchanged. |
| DeepSeek broker | PR #2 broker/runtime/checkout source merged through PR #19; publication/evidence readback verified. Normal startup deliberately disabled; independent v2 source review accepted, 188/188 tests passed with zero skips/failures. Worker ledger governs this bounded acceptance. |
| Candidate admission | Optional controller-owned final-candidate importer and bound verifier facade independently accepted as inactive source; clean-install 202/202 tests and build/typecheck/validate PASS; [separate foundation validation](../docs/validation/2026-10-14-foundation.md). No startup wiring, live artifact transport or recovery checkpoint admission. |
| Worker activation | Operational admission composition, recovery strategy/checkpoint executor, cancellation propagation, exact-container reconciliation and conservative interrupted-spend/quarantine release OPEN. |
| Worker historical evidence | 40 original evidence blobs, three state archives and three historical checkpoint documents preserved and verified. Original controlled-provider proof does not certify this successor. |
| Jev/recovery, learning, scheduling | Source composed; negative-evidence freshness and cohort repairs passed combined source acceptance. Live Jev, genuine activation, holdout/baseline evaluation and comparable benefit OPEN. |
| Orloom CI | Historical actual full-suite `f6023ac` FAIL/271438 ms/zero certificates. Fixture repair is composed; authentic exact-candidate runsc full suite OPEN. |
| Local integration | Historical `2a02606` source and actual two-pool PostgreSQL replay accepted within retained scope. New candidate is not thereby certified. |
| Controller and delivery | Historical `0725fa2` policy composition and `f6023ac` delivery PostgreSQL proofs bounded. Combined live PostgreSQL and deployment gates OPEN. |
| Reserved remote upload | `954622e` historical source/ref-replay proof; secure App/R2 configuration and real credentialed publication OPEN. |
| Living Loom | Controlled source/browser evidence exists; certificate-digest closure repair passed combined source acceptance. Canonical five-sector/source-inspection interactions and live-builder display remain incomplete. |
| Packaging / fixture throughput | Docker helper-source repair passed source regression; clean image build still OPEN. Historical `e078a51` 151-test/14-gate source checkpoint is not the new result or Linux isolation proof. |
| Slice 1b owner cancellation | Durable owner-authenticated cancellation through the Governor; a cancelled slice retains its lease proof and capacity slot, blocks claims/integration/delivery, and cannot be resurrected by expiry or reconciliation. Interleaved claim/cancel regression included. Pre-existing non-idempotent `005_learning.sql` fixed (startup re-executes every migration). [Slice 1b record](../docs/validation/2026-10-14-slice1b-owner-cancellation.md). Worker cancellation propagation and absence proof remain Slice 2. |
| Slice 1a runtime intent | Durable controller-owned runtime intent persisted before container creation, retaining the exact container ID; journal reused from the preserved successor `5c59eb3` with review-driven fixes (locale-stable persisted digest, expiry-stable run identity, no orphan on a failed binding). Source/fixture only: no Docker/runsc/Linux execution, and not wired into startup. [Slice 1a record](../docs/validation/2026-10-14-slice1a-runtime-intent.md). Slice 1b (owner cancellation with epoch fencing) NOT started. |
| Slice 0 baseline | `main` `86a9723` / tree `10de087b` rechecked 2026-10-14 with zero open PRs; fresh locked install + typecheck/build/validate exit 0; Windows suite 189/202 with all 13 failures classified as the documented Linux/POSIX candidate-admission platform guard; retained 119-file manifest re-verified byte-for-byte. [Baseline record](../docs/validation/2026-10-14-slice0-baseline.md). No runtime gate closed. |
| Evidence preservation | PR #14's 95 original evidence blobs and two historical state files, plus PR #15's two repair records and two historical state/manifest blobs, are preserved. All 15 PR #3–17 trees have no absent original paths after the 97 evidence additions. Historical records do not certify the containing commit. |
| Cloud end-to-end | Secure credentials, live workers, authentic verification, operational recovery, deployed campaign and measured learning gains OPEN. |

Direction: preserve source and evidence; validate/review one coherent candidate; perform authorized PR cleanup only after inclusion and acceptance are established. The owner's latest direction supersedes the earlier blanket no-merge restriction. PR #2 is closed as superseded after verified source/evidence inclusion; all original PRs #2–17 are resolved. That cleanup does not authorize runtime activation. No GitHub Actions CI, competing broker/scheduler, automatic UNKNOWN replay or newly implied paid-host/provider authority.


Foundation progression: [acceptance checklist and next-step map](../docs/FOUNDATION_STATUS.md). Candidate admission is a bounded optional source bridge; runtime composition and all activation gates remain open. No broad architecture rewrite or live activation is implied.

## PR23 verifier repair — review pending

- `PR23-REPAIR-001` repairs `docs/validation/slice1c-review-findings/verify-1c.mjs` to verify a full requested commit from a fresh user-local Linux clone, run locked install/build/validation/tests against that checkout, and fail closed on missing or malformed committed manifests/blobs.
- Source candidate S: `7396750c540eeac538b98c7f05c0293bad98cd6a`. Evidence candidate E: `81067c0be674b3c1e1821144b69cc5b3eb736858`. E retains both the failed `/tmp` harness attempt and the passing persistent-checkout run; the old Windows logs are unchanged.
- Linux final gates: install, typecheck, build, validate, verifier regressions, focused suite and full suite passed. Full suite: 247/248 pass, zero failures, one deployment-host ownership/mode test skipped. The exact source and evidence manifests are verified against committed blobs. See [PR23 receipt](../docs/validation/2026-10-14-pr23-verifier-receipt.md).
- State: implementation and local validation complete; independent review of the exact R candidate is pending. This bounded source proof does not close operational runtime, actual PostgreSQL, runsc, provider, deployment, or product finish gates.


| Approved composition successor (2026-10-15) | Active bounded source packet: protected admission startup, exact approved single Docker lane API, trusted cancellation settlement/replay. Final candidate validation/review pending; normal worker main disabled; no live provider/PR or deployment claim. See [ledger](../docs/validation/2026-10-15-approved-composition.md). |

Final source gates for approved composition: build/typecheck/validate PASS; Linux 285/287 with zero failures and two existing skips; actual PostgreSQL two-pool proof PASS; independent bounded source review PASS. Operational gates remain open; exact commit/PR recorded at publication.

## Explicit approved startup successor (2026-10-15)

PR25 repair head `27b786b140a2f0f73141aa60175b939b8f6ba605` remains frozen for external re-review. The separate stacked branch adds normal explicit-config one-task startup, atomic targeted claim, scoped trusted restart reconciliation, shutdown propagation and certified integration/draft-delivery composition. Defaults stay disabled. Exact final gates and bounded acceptance are recorded in [startup ledger](../docs/validation/2026-10-15-explicit-approved-startup.md). Live provider/runsc/remote delivery, deployment, scheduling and learning gates remain OPEN. Do not merge or activate either PR without its separate authority.

## PR26 restart repair (2026-10-15)

PR25 repaired head `27b786b140a2f0f73141aa60175b939b8f6ba605` passed external re-review and remains unchanged. PR26 review of `a8644549b83826f2112bb8f5ad21279c5122aa23` found three reproduced restart defects missed by the earlier bounded review. [Repair ledger](../docs/validation/2026-10-15-pr26-restart-repair.md) supersedes startup acceptance: distinct validated normal absence, atomic no-runtime owner cancellation and exact-target verification eligibility. Real journal/store callback regressions, focused Linux and actual PostgreSQL passed; final full suite and repaired-head publication/re-review are tracked there. No live activation, merge, deployment or live-site changes.

## PR26 expired cancellation follow-up

External review 5537793590 accepted the prior three direct fixes but reproduced claim→expiry→owner cancellation leaving a no-runtime UNKNOWN slice unsettled. The one-predicate [follow-up](../docs/validation/2026-10-15-pr26-expired-cancellation.md) uses the same atomic settlement fence only for cancelling UNKNOWN, preserving all ordinary/bound UNKNOWN quarantine and spend. RED memory/SQL cases and passing controls are retained; focused Linux, actual PostgreSQL and narrow independent source review pass. No further product branch or runtime activation is authorized while review is pending.

## Owner readiness and recovery successor

PR25 and PR26 exact heads above passed independent review and remain frozen/unmerged. Owner authorized READY packet OWNER_READINESS_PACKET.md on feat/owner-readiness-recovery, stacked on accepted PR26 9347c170. Existing canonical inspector gains truthful configuration prerequisites, cancellation state and durable recovery references. Final evidence/review/publication tracked in docs/validation/2026-10-15-owner-readiness.md. No live host/runtime/provider/deployment authority.

Rebase override (2026-10-15): the UI successor is locally rebased onto repaired PR26 `2dc187651b2616f8274eba31b07862ffaffafbc6`. Historical UI gates/manifests below apply to pre-rebase `c6a6b264a84a374b82b198ff3129216c25092e09` only. Current combined candidate remains HOLD for fresh source/build/browser/PostgreSQL/full-suite verification and independent review. No UI branch push or PR publication occurred. PR26 exact-head external review remains OPEN.
