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

The ORL-004 queue-only service is deployed on Hostinger. ORL-005A is accepted locally but has not been rolled out; its eight-connection PostgreSQL proof used a disposable database and was cleaned up. ORL-ISO-001 independently proved two short-lived credential-free gVisor smoke sandboxes and launcher denial checks, not representative build capacity or six-lane readiness. ORL-005B adds local broker, exact-SHA checkout, bounded DeepSeek tool protocol, stdin source transfer, isolated workspace, and candidate/evidence code; it has not been remotely built or run, and no live DeepSeek/GitHub/R2 operation has been performed. Mission-schema production rollout, verifier/Forge, independent trusted checks, active recovery, audit retention, production monitoring/backups/recovery, and browser acceptance remain open. Do not infer product readiness from the deployed queue, PGlite, local gates, or isolation smoke.

## ORL-005A mission control spine

This implementation slice is accepted only when the authenticated HTTP mission path, immutable mission data, validated owner-authored DAG, separate approval, transactional PostgreSQL storage/claim fencing, durable event replay, cumulative budget reservations, attested capacity slots, and fenced worker authority boundaries pass deterministic gates. The browser must display API-backed mission and event state. Planned dependency waits use `waiting_dependency` and do not reserve a slot or quarantine a scope. Candidate callbacks stop at `awaiting_verification`; this branch exposes no verifier integration endpoint, so the gate remains closed and dependent slices remain `waiting_dependency`. A bounded startup and periodic reconciler, also invoked before claims, turns expired running work into durable `unknown` without releasing reservations, slots, or scopes.

This slice does not complete the product. Real PostgreSQL pool concurrency, production migration rollout, worker isolation, actual provider metering, credential/network confinement, Forge checks, verifier evidence inspection, real Git integration, and remote/browser runtime acceptance remain open. BLOCKED/UNKNOWN outcomes and expired leases retain budget and quarantine their capacity slot and overlapping repository scope. Local/PGlite checks do not establish live readiness.

## ORL-005B worker broker checkpoint

The local B candidate connects the fenced A HTTP lease protocol to exact immutable GitHub checkout, explicitly disabled DeepSeek reasoning, exact-model listing plus a forced function-call capability probe, pre-reserved request bounds, fixed tool dispatch, trusted local pricing/check policies, digest-checked evidence/progress writes, and a nonroot/no-network `runsc` Docker invocation using bounded stdin source transfer. A handoff retains a verified Git bundle with the candidate commit before disposable checkout cleanup. The worker can only submit a candidate or typed `BLOCKED`/`UNKNOWN` outcome under its mission/slice/epoch lease capability; integration remains unavailable. These are source-level implementation claims until exact-candidate tests and independent review pass. No worker image digest has been built/verified on the host, no remote job or provider probe has run, live GitHub/R2 credentials were not read, and no throughput/capacity claim is established. Durable R2 progress records do not yet implement active mission-bound recovery/continue decisions; that remains ORL-005C. Keep live dispatch closed until image review, secure secret connection, independent PostgreSQL runtime proof, trusted checks/pricing, and owner-authorized capped provider validation are all satisfied.
