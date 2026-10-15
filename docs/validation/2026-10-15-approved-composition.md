# Approved single-lane composition

Scope: owner-approved one-slice execution, final-candidate admission, independent check coordination and conservative cancellation settlement. Baseline `eed0a9264ec2b5c64f59a247a4aa6be93e3677e4`, tree `6666a4b575e6fc412b0a165eebbde720f1a83423`. Source delivery is for independent review; it is not deployment or product completion.

## Changed behavior

`createTrustedVerificationRunner` now constructs the protected admitting runner only with complete explicit verifier, repository, private admission-root and R2 configuration. Missing configuration leaves it disabled; partial/invalid configuration refuses startup before artifact transport construction. Existing control-plane startup consumes this factory.

`runApprovedDockerWorkerLane` is a trusted in-process composition API for one exact approved lease. It constructs the concrete existing Docker runtime with the controller-private journal bridge. The generic `runApprovedWorkerLane` is the injectable source/test seam. Both validate persisted owner approval, one-slice plan, mission content, base, plan/check digests, reservation and current lease credentials before the builder. Duplicate in-process calls are fenced. Existing `executeLease` owns building/submission; existing trusted coordinator owns final checks. A check certificate does not mark the slice integrated or the mission verified.

Cancellation uses controller-private store methods, with no worker-facing settlement API. Immutable runtime identity, labels, image and container ID bind exact absence proof. Terminal journal records remain readable after restart and retry transient SQL container-binding failures. Exact absence or an atomic never-started fence can settle owner cancellation, including after candidate submission. Capacity is reusable after settlement; reserved spend is unchanged. UNKNOWN never establishes absence or permits refunds.

## Evidence and acceptance ledger

Evidence directory: [composition evidence](2026-10-15-composition/). `verifier-baseline-red.txt` reproduces two expected baseline failures using the baseline verifier transpiled into disposable dist output; `journal-red.txt` reproduces absent evidence replay failure before the new journal API. The production source was rebuilt afterward.

Initial Linux serial suite: 281 tests, 279 pass, zero failures, two declared skips, 123899 ms. It predates review repairs and the new integrated fixture. Both skips are existing environment/platform-specific tests; final results are recorded separately. Initial actual PostgreSQL 18 two-pool proof passes claim contention, quarantine, exact settlement, idempotent replay, preserved reservation and capacity reuse. These are bounded real database checks with controlled runtime observations, not Docker or provider execution.

`integration.txt` records a passing deterministic lifecycle: owner-authenticated HTTP plan/approval, existing worker executor, genuine local Git bundle, SQL state, protected importer, controlled independent launcher, exact-SHA certificate and durable Loom events. Provider, workspace and launcher are explicitly fixtures. PGlite is not external PostgreSQL. The temporary PostgreSQL proof uses no provider credentials and listens only on a local Unix socket.

The [first independent review](2026-10-15-composition/REVIEW-1.md) returned FIX. Its liveness and concrete-runtime findings were repaired with regressions; final gate and review outputs are retained in this directory. Failed Windows sandbox hard-link/loopback attempts and corrected integration-fixture session-status failure remain described here rather than counted as passes. Final acceptance applies only to the final source manifest recorded alongside results.

Final gates (2026-10-15 16:55 UTC): build/typecheck/validate exit 0; clean serial Linux Node 24.22.0 suite 287 total, 285 pass, zero fail/cancelled, two existing skips, 125907.473057 ms ([exact final output](2026-10-15-composition/final-linux-suite.txt)). Skips: the non-Linux-only operational-journal guard test and the local npm config-path test guarded off outside its enabled environment. No runsc check was silently counted as executed. Actual PostgreSQL 18 fresh database proof exit 0, two-pool single winner and idempotent exact settlement/capacity reuse with all 100 reserved cents retained ([output](2026-10-15-composition/postgres.txt)). [Independent repaired-source review](2026-10-15-composition/REVIEW-2.md): PASS for bounded source, subject to these gates. The 126-entry [final source manifest](2026-10-15-composition/final-source-manifest.json) was refreshed after the test-database isolation fix and verified with zero mismatches after the final suite. Previous state/graph archive Git blobs exactly match the baseline originals.

## Deliberate limits

Normal worker main remains disabled; this PR supplies the bounded trusted composition API, not an enabled daemon or paid-provider path. It does not invoke delivery automatically. The deployed URL and canonical UI were not modified. There was no credential creation, paid provider call, remote worker launch, merge or deployment.

If SQL intent registration succeeds but the trusted file journal cannot persist intent, automatic settlement remains quarantined for operator reconciliation. A lost journal is not evidence of runtime absence. Billing reconciliation/refunds and cross-host restart ownership remain operational gates. In-process duplicate fencing complements the existing Linux service lifetime lock; it is not a distributed executor lease.

## Remaining product work and authority

| Canonical requirement | Next concrete work | Authority boundary |
|---|---|---|
| Idea → approved plan | Configure Sol planning against owner objective; show/edit/approve the actual graph in the canonical UI | Source work authorized; provider use needs secure credentials and a spend ceiling |
| Real execution | Compose the bounded API into a trusted operational service with restart ownership and visible start/stop/resume | Source work authorized; deployment/activation needs explicit release authority |
| Multiple builders | Extend exact lease/runtime lifecycle to independent isolated lanes with capacity evidence | Source work authorized; hosts/provider spending require approval |
| Stuck recovery | Consume authorized finite recovery actions and admit bound checkpoints, test interrupted strategy outcomes | Source work authorized; paid live experiments require approval |
| Learning | Connect controlled lesson activation and evaluate fresh comparable tasks with baseline/holdout and withdrawal | Source work authorized; gains remain unmeasured until real evaluation |
| Orloom CI | Accept clean digest-pinned Docker/runsc images and execute exact-candidate final checks on isolated workers | No host/security changes or release is authorized here |
| Real UI/Loom | Display real execution/certificate/cancellation evidence and owner recovery actions in existing canonical UI | Source/UI integration authorized; deploying changes requires release approval |
| Verified GitHub PR | Owner-approved target task/base/scope/checks, scoped GitHub App/R2 credentials, verified worker/verifier images, bounded provider budget, then controlled delivery | Minimum missing approval: exact target task/repository plus spend ceiling and secure configuration/activation; no fixture may be called live |

Publishing this implementation branch for source review is authorized. It is separate from an Orloom-generated PR demonstrating autonomous execution.
