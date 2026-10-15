# Orloom current state

Updated 2026-10-15 UTC. Authority: [canonical harness](../docs/architecture/CANONICAL_HARNESS.md), [work graph](WORK_GRAPH.md), latest owner delegation. Product completion remains OPEN. Replaced state/graph bytes are archived under `.agent/archive/2026-10-15-before-pr26-capacity-*`.

Main is e7e5119865144c525132b6ab04fa8aa2c371e14c after the independently authorized PR25 merge. PR26 targets main on feat/explicit-approved-worker-startup. Independent reviewer owns merge; this checkout must not merge or deploy.

Formal review 5538859140 confirms prior shutdown and long-expiry fixes but supersedes acceptance at 2dc187651b2616f8274eba31b07862ffaffafbc6: awaiting the lifecycle callback before reserving the verifier slot allows two concurrent launches at limit 1. [Current packet](PR26_CAPACITY_PACKET.md) and [ledger](../docs/validation/2026-10-15-pr26-verifier-capacity.md) govern the correction. Slot reservation now precedes the first await and releases in finally; request expiry is rechecked before dispatch. No shutdown fence or UNKNOWN authority is weakened.

Actual clean-build RED reproduces both absent/delayed guard peak 2 and expiry-after-guard dispatch, with four passing controls. Focused Linux 28/28 passes. Build/typecheck/validate and bounded independent source review PASS; full Node24 Linux suite PASS: 370 total,368 pass,zero failures,two existing skips. All 187 source hashes match manifest 046b011c9c09cf84e8fadfd938ca55513ca90a3acf3821d2577e02b162a9a161. Next: final gate/hash reconciliation, exact-head publication and external re-review. Prior ledgers remain historical.

UI successor and combined validation are saved separately at da09d1987db9db13cfaa8b632fd48d77bba0be99. UI browser/PostgreSQL and 373-test combined suite passed, but do not override this base defect. Publication HOLD until corrected base, rebase and fresh combined acceptance. Canonical UI remains unchanged by PR26. Separately approved host preparation is tracked in private operational evidence; paid AI remains off.

Composition remains one owner-bound task/lane with trusted candidate admission, independent verification and controller-owned integration/draft delivery. Unconfigured startup stays disabled. Unknown effects, exact claimed identities, cancellation proofs and conservative reservations remain authoritative. No retry, force settlement or refund is inferred from worker reports.

Live acceptance remains OPEN: exact approved target/base/scopes/checks, secure existing credential bindings, bounded spend/activation, accepted runtime/images and authentic verification/GitHub delivery/Loom events. Fixtures and actual isolated PostgreSQL do not close those gates. Judgment, scheduling and learning remain unconfigured. No merge, deployment, credential creation, provider activity or real worker GitHub delivery occurs in this source repair.

UI successor rebase override: owner authorized fresh combined validation and publication atop corrected PR26 a92e6a8c9de77828dcdf0f9367cc0434cc7b7f77. Prior UI browser/PostgreSQL/373-test gates at base2dc remain historical only; fresh combined acceptance is required before publication. Canonical geometry, layout, aesthetic and execution authority remain preserved. No UI source changes during this rebase.
