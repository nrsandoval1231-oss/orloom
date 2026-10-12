# Opening Tribunal — 2026-10-12

Objective: durable, auditable single-user repository job foundation.
Luna simplifier: one frontend/API, one worker, no autoscaling or multi-user system.
Terra engineer: durable Postgres state, scoped worker protocol, immutable R2 evidence, server-side GitHub credentials.
Sol architect decision: MODIFY — proceed with foundation; isolation proof and owner authorization required before live execution.

Build now: Node 24 TypeScript workspace, runnable local frontend/control plane, job contracts and PostgreSQL migration/repository, provider adapters, configuration validation, secure templates, Forge-owned CI contract and independent local tests.
Do not build yet: autonomous execution/merge/deploy, infrastructure provisioning, billing, multi-agent orchestration, changes to Aura/forge-agent.
Architecture: browser -> control plane -> PostgreSQL; isolated DO worker pulls scoped job leases via API; R2 stores evidence; GitHub App handles repository/check integration; Codex SDK is an execution adapter without authority. Forge trusted validation policy lives outside target checkout. No GitHub Actions.
Assumptions: one operator and one active job; local fake providers are explicitly identified and cannot imply cloud readiness.
Risks: repository code escaping worker, credential leakage, lease replay, ambiguous interrupted effects, untrusted validation policy.
Sequence: contracts -> local API/UI and DB boundary -> adapters -> checks -> independent review -> secure connection handoff.
