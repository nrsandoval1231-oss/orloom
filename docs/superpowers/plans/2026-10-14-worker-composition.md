# Worker Composition Implementation Plan

> For agentic workers: execute task-by-task with independent review before publication.

**Goal:** Retain PR2's bounded broker on the repaired PR17 controller without claiming or enabling an unimplemented candidate-to-verifier handoff.

**Architecture:** Preserve broker execution and isolation. Add only the read-only checkout-token helper to PR17's richer GitHub adapter. Keep startup fail-closed, and introduce a typed HTTP recovery client that can transport controller-authorized progress without converting builder-local checks into trusted evidence.

**Tech stack:** Node 24, TypeScript, node:test, existing PostgreSQL/PGlite control plane.

**Spec:** docs/architecture/CANONICAL_HARNESS.md; audit dated October 14, 2026.

## Constraints
- No provider execution, secrets, token creation, deployment or remote writes in this work.
- Preserve six-lane capacity, independent validation, immutable lease fences, delivery authority separation and UNKNOWN quarantine.
- Frozen PR2 source remains unchanged in its branch. Composition is a new candidate; do not replace PR17 contracts/configuration/provider adapters wholesale.
- This bounded slice does not claim autonomous completion or live improvement.

## Review focus
- Replacing adapters must not erase delivery authority or broaden token permissions.
- Generic telemetry must never become a trusted-check pass.
- Stale plan/policy/capability must fail before recovery requests.
- Ambiguous HTTP writes must not be blindly retried.
- Startup must not read credentials or claim work while candidate admission is unavailable.

## Task 1: Source composition
- [x] Copy unique worker runtime, sandbox, pool, checkout, worker loop and five tests from PR2 639bff0759870d3522ae38d2887b75fe6c4297c7.
- [x] Port createCheckoutToken only; keep the existing GitHubInstallationClient interface compatible with delivery fixtures by returning its intersection with a new GitHubCheckoutClient.
- [x] Retain PR17's package scripts, build/copy-git-askpass, dependencies and admission digests unchanged.
- [x] Run typecheck and broker/checkout/delivery regression tests.

## Task 2: Fail-closed composition seam
- [x] Preserve PR2 main as broker-main.ts; keep main.ts a credential-free refusal until candidate admission/reconciliation is implemented and reviewed.
- [x] Add HttpRecoveryControlPlane.recoveryPolicy(lease) and recordProgress(lease, progress), using the existing routes, capability headers, fixed timeout, no redirects and no retries.
- [x] Reject generic builder telemetry and v1 terminal progress locally. Controller remains sole authority validating trusted attempts, strategies and decisions.
- [x] Test real HTTP policy/progress path and rejection of mismatched identities, stale digest, fake trusted completion and missing verifier; test parked startup process.

## Next bounded controller slice (not implemented here)
1. Candidate admission: controller-owned R2 bundle reader with digest readback, repository/base/candidate/lease binding, strict size and object limits, scope diff validation and isolated per-attempt Git object admission. Never checkout untrusted code on controller or share mutable HEAD across six builders. Adapt prepareBundle/observeHead to candidate-specific admission identity and immutable observation. Test forged bundle, wrong ancestor, path/symlink escape, oversized input, concurrent candidates and head changes.
2. Recovery bridge: persist check checkpoints, invoke independent recovery-check, submit v2 progress from returned trusted attempt identity, honor only freshly authorized alternatives, then test fail→change strategy→independent pass and replan/escalation. Generic telemetry stays distinct. Do not manufacture success from builder run_check.
3. Cancellation/reconciliation: durable owner cancellation intent fences capability/epoch first; broker stops effects, kills exact labeled container and proves absence. Separate independent reconciliation event releases slot/scope only after cleanup and effect/spend accounting are resolved. Retain unknown budget liabilities; never refund or requeue on timeout alone. Test shutdown during an in-flight claim (no new effect after shutdown), interruption of active execution, late completion, double cancellation, broker restart, daemon unavailable, partial cleanup and concurrent cancel/verify.
4. Startup: explicit dependency-injected factory for broker, controller judgment and scheduling; deterministic fallback documented; acceptance gate requires admitted-candidate verifier plus recovery/cancellation components, not a boolean environment escape hatch.
5. Run one real authorized goal→builder→independent reviewer/CI→integration→delivery mission before measuring six live builders. Live credentials, resource provisioning and publication remain separately authorized.

## Acceptance matrix
| Boundary | Passing evidence | Remaining gap |
|---|---|---|
| Source composition | Typecheck and existing broker/checkout/delivery tests | Not a deployment |
| Worker transport | Real loopback HTTP candidate reaches awaiting_verification | Fixture provider/workspace |
| Recovery client | Actual Governor accepts nonterminal typed progress; rejects forged terminal | No automatic strategy execution |
| Startup | Exit 1 before credentials/network | Intentionally disabled |
| Candidate import | Explicit unavailable seam | Next controller slice |
| Cancellation | Quarantine retained | No safe owner release path yet |
| Independent delivery | Existing PR17 tests retained | No composed end-to-end live mission |
