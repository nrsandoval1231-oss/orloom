# Finish contract

## ORL-001 foundation is complete when

- Node 24 installation from the committed lockfile, typecheck, tests, build, and structure validation pass.
- Local HTTP status and authenticated queue-only job submission behave as documented.
- PostgreSQL migration constraints and job transitions run against PGlite; stale completion is fenced and interrupted running work becomes `unknown`.
- Worker startup fails closed; there is no arbitrary shell or live provider endpoint.
- Provider seams use server-side credentials, have no live calls in tests, and the Codex SDK package is pinned.
- GitHub installation-token requests explicitly restrict repositories and permissions; R2 writes are conditional and reads verify content digests.
- Local startup loads an ignored `.env` file; role-specific configuration checks reveal field names only.
- Credential guidance, architecture, deployment prerequisites, and external Forge policy are documented.

## Deployed queue baseline and product finish line

The ORL-004 queue-only service is deployed on Hostinger. ORL-005A was independently revalidated and merged through PR #1 at main `6110c692f47202978b2d22d22f6522aa4aa59277`; it has not been rolled out. [The revalidation record](evidence/pr1-revalidation/EVIDENCE.md) includes a fresh disposable PostgreSQL concurrency/restart proof. ORL-ISO-001 has independent bounded evidence for two credential-free concurrent gVisor smoke sandboxes and launcher denial checks; this is configuration/isolation smoke proof, not live worker build capacity or six-lane readiness. Production migration/concurrency, GitHub App installation flow, worker job execution, network/credential confinement for real jobs, Orloom-owned trusted CI, audit retention, monitoring, backups, and recovery remain unbuilt or unproven. GitHub and R2 adapters have not made live requests. Do not infer product readiness from the deployed queue, local gates, PGlite, or the bounded isolation smoke.

## ORL-005A mission control spine

This implementation slice is accepted only when the authenticated HTTP mission path, immutable mission data, validated owner-authored DAG, separate approval, transactional PostgreSQL storage/claim fencing, durable event replay, cumulative budget reservations, attested capacity slots, and fenced worker authority boundaries pass deterministic gates. The browser must display API-backed mission and event state. Planned dependency waits use `waiting_dependency` and do not reserve a slot or quarantine a scope. Candidate callbacks stop at `awaiting_verification`; this branch exposes no verifier integration endpoint, so the gate remains closed and dependent slices remain `waiting_dependency`. A bounded startup and periodic reconciler, also invoked before claims, turns expired running work into durable `unknown` without releasing reservations, slots, or scopes.

This slice does not complete the product. Disposable real PostgreSQL pool concurrency is proven within the retained test scope; production migration rollout, worker execution isolation, actual provider metering, credential/network confinement, Orloom-owned checks, verifier evidence inspection, real Git integration, and remote/browser runtime acceptance remain open. BLOCKED/UNKNOWN outcomes and expired leases retain budget and quarantine their capacity slot and overlapping repository scope. Local/PGlite checks do not establish live readiness.

## Revised harness acceptance boundary

C1a source `545279c7b53fef8453c8e50ae0bc7f0d790959af` has independent source review, 51 deterministic tests, and a real PostgreSQL HTTP proof retained in [C1a evidence](evidence/c1a-runtime/EVIDENCE.md). Final evidence review qualifies only the bounded checkpoint: finite authorized recovery and durable candidate episodes. Independent lesson validation/promotion, application to later comparable tasks, withdrawal, broader stuck detection and measured benefits remain mandatory C1b acceptance. The next C3 prerequisite is a real isolated exact-commit check with durable artifacts and fenced certification; a syntax-only certificate cannot satisfy full CI build/test/lint/typecheck/security requirements or authorize lesson promotion by itself.

The canonical specification governs subsequent work. PR #2 remains frozen at `8bbcfffbf631e5ad2972e34b41284198afc566e2`; none of its incomplete behavior may be counted as an integration dependency or completed capability. Jev judgment, active recovery, evidence-governed learning, adaptive Athena scheduling, independent exact-commit CI, integration/PR delivery, and real-event Living Loom require their own integrated implementation and retained behavioral evidence. Injected provider fixtures are not live Jev execution. A controlled recovery scenario is not measured production learning improvement. A repository merge is not a cloud deployment or certified engineering outcome.
