# Orloom — Canonical Minimal Architecture
Status: **AUTHORITATIVE TARGET** (2026-10-21), superseding the prior multi-agent harness specification. Operational acceptance remains unproven until a real end-to-end mission succeeds.

## One-path system
UI / authenticated mission API → durable mission record → bounded coding worker → disposable isolated checkout → coding-agent engine → trusted checks → GitHub branch and PR → truthful result UI.

The model may plan and iterate *inside one coding session*. There is no requirement for separate planner, builder, reviewer or arbiter LLMs.

## Keep only necessary responsibilities
- **Web/control plane:** owner auth, create/read/cancel mission, durable state, event stream, limits, delivery status.
- **Worker:** single mission execution, credential-safe checkout, bounded agent invocation, test/retry and PR delivery.
- **Isolation:** disposable run container/VM separate from control plane; no control-plane secrets in checkout; limit network/credentials/resources.
- **Evidence:** changed SHA, meaningful checks, commands/results, error excerpts and PR URL. No elaborate certification theater.
- **GitHub:** source, branches, and owner-reviewed PRs.
- **Data store:** one durable mission state and enough recovery data to prevent duplicate unsafe effects.

Use existing pieces where possible; do not create a parallel replacement stack.

## Mandatory simplification and removal order
1. Add a true live end-to-end smoke test with a controlled target repo and acceptance report. Until then mark live coding UNVERIFIED.
2. Identify the minimum working execution path and remove multi-agent/advisory orchestration from it: Athena, Sol, Jev, independent adversarial reviewer, learning promotion, scheduler graph and concurrent fleet are **not** dependencies.
3. Collapse owner-facing mission setup into repository, task and optional acceptance criteria. Internal defaults replace plan-authoring, per-slice approval and policy configuration.
4. Replace visual Loom as primary experience with simple task status, activity, diff, test output, PR link and useful failure explanation.
5. Characterize dependencies and retire unused components, database tables, configuration, endpoints and tests in reviewable deletion batches. Do not drop persisted data until migration/export is planned.
6. Keep isolation, credential limits, execution ceilings, cancellation, unknown-state reconciliation and no-auto-merge. Simplify their implementations without removing the protections.
7. Remove historical agent instruction packets from active instruction discovery; retain archival records outside the runtime path.

## Hard stop on scope
Do not build more architecture to explain why coding is not running. No expansion of multi-agent roles, new committees, learning system, orchestrator or UI visualization until one real PR can be created and verified end to end.

## Release gate
Run a controlled real task from UI through PR and record actual evidence. Build, typecheck and unit tests alone cannot close this gate.

## Status distinction
This document changes policy and design intent. It does **not** assert that worker startup, sandbox, model invocation, remediation, or PR publication are currently operational.
