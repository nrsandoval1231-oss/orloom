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

The ORL-004 queue-only service is deployed on Hostinger. ORL-005A is a local feature branch and has not been rolled out. ORL-ISO-001 has independent bounded evidence for two credential-free concurrent gVisor smoke sandboxes and launcher denial checks; this is configuration/isolation smoke proof, not live worker build capacity or six-lane readiness. Production PostgreSQL concurrency, production session hardening, GitHub App installation flow, worker job execution, network/credential confinement for real jobs, Forge scheduler and trusted CI execution, audit retention, monitoring, backups, and recovery remain unbuilt or unproven. GitHub and R2 adapters have not made live requests. Do not infer product readiness from the deployed queue, local gates, PGlite, or the bounded isolation smoke.

## ORL-005A mission control spine

This implementation slice is accepted only when the authenticated HTTP mission path, immutable mission data, validated owner-authored DAG, separate approval, transactional PostgreSQL storage/claim fencing, durable event replay, cumulative budget reservations, attested capacity slots, and fenced worker authority boundaries pass deterministic gates. The browser must display API-backed mission and event state. Planned dependency waits use `waiting_dependency` and do not reserve a slot or quarantine a scope. Candidate callbacks stop at `awaiting_verification`; this branch exposes no verifier integration endpoint, so the gate remains closed and dependent slices remain `waiting_dependency`. A bounded startup and periodic reconciler, also invoked before claims, turns expired running work into durable `unknown` without releasing reservations, slots, or scopes.

This slice does not complete the product. Real PostgreSQL pool concurrency, production migration rollout, worker isolation, actual provider metering, credential/network confinement, Forge checks, verifier evidence inspection, real Git integration, and remote/browser runtime acceptance remain open. BLOCKED/UNKNOWN outcomes and expired leases retain budget and quarantine their capacity slot and overlapping repository scope. Local/PGlite checks do not establish live readiness.
