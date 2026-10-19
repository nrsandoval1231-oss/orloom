# Orloom completion implementation plan

> For agentic workers: use the owner-supplied agent-harness packet workflow. Implement one READY node with one Luna; use Sol for independent review. This plan is sequencing, not activation or spending authority.

**Goal:** An owner-approved objective becomes independently verified, integrated code and a read-back-confirmed draft GitHub PR, with autonomous execution inside explicit scope and budget and owner-controlled merge/release.

**Architecture:** Keep PostgreSQL and the web control plane on Hostinger, isolated execution and trusted verification on DigitalOcean, evidence in R2, and GitHub for source/Checks/draft delivery. Extend the existing Governor, approved worker, verifier, integration, recovery and learning contracts. Establish one real path before adding durable automatic handoffs and then useful concurrency.

**Tech stack:** Node 24, TypeScript, PostgreSQL, Docker/runsc, GitHub App, R2, DeepSeek, existing TypeSafe Jev adapter.

**Spec:** `docs/architecture/CANONICAL_HARNESS.md`, `docs/FINISH_CONTRACT.md`, `.agent/FIRST_LIVE_WORKFLOW_PACKET.md`, `docs/design/FOREST_BRASS_UI_V1_1.md`.

## Observed state, 2026-10-19 UTC

| Surface | Current evidence | Consequence |
|---|---|---|
| GitHub | main `8a910f0bf58bbe9db457cb971996a9b2bba32101`; only open PR is draft #32, `6d9ded07088079da88ed0b43dbc1249e26aac2cd` | PR32 is source repair, not a product-generated acceptance PR. |
| Checks | PR32 has zero check runs and zero commit statuses; no Actions runs or GitHub deployments | No hosted CI PASS. GitHub Actions must remain absent; use Orloom verification and optionally publish Checks. |
| Repository enforcement | main branch-protection endpoint returns `Branch not protected`; effective main rules and repository rulesets are empty | Application delivery guards exist, but GitHub does not currently enforce owner-controlled main changes. Configure a supported protection/ruleset before enabling autonomous write delivery. |
| Linux source gates | Fresh detached PR32 clone, Node 24.15.0: locked install/typecheck/test/build/validate/diff-check all exit 0; 400 tests, 399 pass, zero fail, one deployment-host ownership/mode skip | Local source evidence only; the existing suite missed the builder wiring defect below. |
| Hosted app | HTTPS health 200 with `liveExecution:false`; app and PostgreSQL healthy; revision `c2ad774198a64ff829ac2bc68ce04ce2883ac611`, image `sha256:c3fb5c3cf75324026b4bee6a94c2f00fc65febc63df0b3b2a14e75b76311e30e` | UI release is deployed. This inspection did not repeat authenticated desktop/mobile browser acceptance. |
| Runtime controls | One maximum lane, zero capacity slots, integration/delivery false; existing Compose project and `orloom_postgres_data` | Disabled execution is intentional. Preserve the current UI and DB. |
| Approved real task | Mission `09d349b4-7518-4548-bc6f-39486a294780`, approved one docs slice, base `8a910f0...`, 100 cents, zero reserved, epoch 0, no candidate; production verification attempts = 0 | There is no live engineering result or verified PR yet. Existing approval is immutable; changed objective/base needs a new approval. |
| Worker | Active droplet 609833278 / `codex-keen-tide-df25`; runsc installed; only factory image/container present; DB tunnel active; no engineering-worker unit | Rebuild/load exact accepted images and qualify them before activation. Historical smoke proof cannot qualify absent images. |
| Credentials | Worker DB/DeepSeek/R2 files present root-owned 0400; no GitHub private-key file in the inspected credential directory; connected GitHub installation-list request returned 403 | Validate the actual configured secure key destination and App installation. Do not borrow another project's key or treat presence as credential validity. |
| Unpublished successor | Preserved `dfc06fd09f76eb20b163f0d7aaff1e0b91182b31`, tree `7676f873bb75f184fbf468ba4e3b183feca15343`, recovered as `recovered/v10-dfc06fd` | Reuse its finite v10 lifetime/local-check repairs; do not rewrite or silently call them deployed. |

PR32's reconciliation Docker runtime receives the validated `executionInputProfile`, but the separate runtime built by `runApprovedDockerWorkerLane` does not. Thus the builder still uses whole-tree input admission and encounters the tracked `deploy/hostinger/init-secrets.sh` guard. The same omission exists at preserved `dfc06fd`. The immediate repair packet is `.agent/ORL_20261019_PROFILE_PACKET.md`.

The v9 trusted suite has a 360-second execution deadline and previously timed out on real runsc. Preserved diagnostics estimated roughly 1,133 seconds for the full profile; those measurements are historical, noncertifying. The explicit reviewed v10 successor uses 1,800 / 1,830 / 1,845 / 1,860 seconds for suite / Docker attach / host launcher / trusted attempt, within the 2,100-second contract ceiling. These changes require a matching rebuilt image, controller/web compatibility and genuine exact-policy runsc proof.

## Global constraints

- Keep the canonical product and approved Forest & Brass UI; no new platform or architecture rewrite.
- Governor alone authorizes leases, budget reservations, scope, integration and delivery. Jev advice cannot grant authority.
- Keep secrets outside source, sandboxes and output logs; use scoped App credentials, private files and credential-manager flows.
- Keep default execution disabled until the relevant accepted operational gate. No new paid task, cloud change, push, merge or deployment is authorized by this plan.
- Retain UNKNOWN quarantine, reservations and runtime identity until trusted reconciliation. No blind retry, refund, duplicate provider attempt or automatic merge.
- Node 24 locked install, typecheck, tests, build and structure validation are mandatory source gates. Genuine trusted verification additionally requires its isolated stages and image/policy-bound receipts.
- Current task authority from the retained packet is one builder execution, at most $1 provider and $5 total dedicated-worker infrastructure. Verify current spend and authority before use; multiple metered model calls, including the required tool probe, must fit the explicit call/token cap and the same reservation.
- Do not modify Aura, forge-agent, GridLens or other services. Hostinger app releases must preserve the database volume and other Compose projects.

## Review focus

1. Startup composes two runtimes: prove the real executing lane receives the same validated options as reconciliation.
2. A policy/image/deadline mismatch must reject before dispatch, including old web reconcilers reading v10 attempts.
3. Duplicate approval, process death or lost acknowledgment must not produce a second paid attempt or remote PR.
4. Cancellation/expiry races must prevent late candidate admission, certification, integration and delivery while retaining ambiguous effects.
5. A reviewer, certificate, Git ref or evidence object that changes after approval must invalidate downstream authorization.

## Ordered work graph and acceptance

### P0-A — Repair approved builder wiring (READY; bounded local work)

**Files:** `apps/worker/src/main.ts`; a small worker runtime-options helper if needed; focused startup/runtime-options regression; `.agent/ORL_20261019_PROFILE_PACKET.md` and its completion record.

**Consumes:** `ValidatedWorkerPolicies.executionInputProfile`, existing `DockerWorkerRuntimeOptions` and the approved-lane runtimeOptions contract. **Produces:** one consistent options assembly for both actual execution and reconciliation; no new authority or configuration.

- [ ] Add a failing composition regression for configured and absent profile. Test actual production assembly, not source text or a duplicated literal.
- [ ] Pass the already validated operator profile into the executing runtime; preserve no-profile fail-closed behavior and all input/security limits.
- [ ] Freeze source and explanatory docs; run locked install, typecheck, full Linux tests, build, validate, diff-check, and independently review that exact commit/tree.
- [ ] Acceptance: regression RED then GREEN, zero new failures/skips, safe disabled default retained; exact source PASS only. Publish to existing PR32 only with owner authorization; no merge or activation follows automatically.

### P0-B — Reconcile PR32 with the preserved v10 successor (depends on P0-A)

**Files:** inspect the full `6d9ded0..dfc06fd` diff first. It includes `packages/{contracts,verification,governor,agents}`, `apps/worker`, verifier scripts, startup/verification/integration tests and ADR `docs/adr/0002-finite-trusted-suite-lifetime.md`.

- [ ] Retain the original bundle, commits, failed 8193 tests, prior reviews and patch. Apply the P0-A fix to a coherent successor based on `dfc06fd` or integrate its two commits serially; resolve main.ts against the shared runtime assembly.
- [ ] Reconcile the existing approved task's exact base/check policy and verify no review/certificate is borrowed across candidates.
- [ ] Acceptance: build/typecheck/validate/full Linux tests and focused expiry, leased-local-command and owner-HTTP cancellation regressions pass at one frozen commit; independent Sol review binds that commit/tree. All v10 lifetime bounds remain exact, finite and image-bound. No stage/resource/security reduction.

### P0-C — Qualify runtime and release compatibility (depends on P0-B; operational authority gate)

**Files/surfaces:** `apps/{worker,control-plane}/Dockerfile`, `apps/worker/Dockerfile.sandbox`, `infra/verifier-isolation/{Dockerfile,launch-verifier.sh,preflight-host.sh}`, current private release helper and Compose overlay.

- [ ] Verify current hourly/cumulative infrastructure spend. Existing worker is already accruing charges; at 15:52 UTC estimated accrual was $2.3375 plus $0.20 prior reserve, actual invoice UNKNOWN. Do not treat the original $5 as a fresh budget.
- [ ] Rebuild from the frozen source, preload immutable worker/verifier images, record source/compiled/image/policy digests and verify runsc isolation under actual non-root operational ownership/modes.
- [ ] Run the genuine full trusted suite on the dedicated host; every mandatory stage must finish inside the admitted policy. Require a durable exact-candidate certificate and exact container-absence proof. runc, a syntax-only check or the local Linux suite cannot substitute.
- [ ] Repair/review the saved Hostinger backup helper findings before execution. Verify encrypted backup, isolated restore, migration/schema compatibility and exact production DB identity. Apply a separately authorized app-only compatible release, preserving the current UI and database.
- [ ] Acceptance: image/policy/attempt bindings agree, full runsc suite passes, operational skipped checks actually run, private permissions pass, TLS/auth/persistence/UI remain correct. After any persisted v10 long-lived effect, old reconcilers are unsafe: use compatible forward repair, not an old-image restart.

### P0-D — Commission one real verified draft PR (depends on P0-C and secure credentials)

**Existing interfaces:** `approved-startup.ts` private `orloom.approved-worker-task.v1`; `approved-service.ts`; `certified-handoff.ts`; `IntegrationRequestV1`; `DeliveryCommandV1`; `packages/integration/src/{local,delivery}.ts`.

- [ ] Establish the Orloom-specific App signing key via secure destination, exact installation/repository permissions and current model/pricing/token budget. Verify scoped GitHub checkout, R2 conditional-write/digest-read and DB access without exposing secret values. Resolve 403 metadata visibility separately from worker-App access.
- [ ] With separate repository-settings authority, enforce default-branch review/check requirements and prevent the delivery App from directly pushing or bypassing them. Confirm actual hosting-plan support and effective rules by readback; owner retains merge authority. Do not enable autonomous delivery while this enforcement remains unresolved.
- [ ] Read durable approved mission/plan, derive the exact private task manifest, and invoke one controlled approved-single execution. Never alter the persisted task to fit a new result or silently allow a second builder execution.
- [ ] Produce a scoped candidate bundle/index, trustworthy usage receipts and exact commit/tree; import through existing admission and independently certify it. Supply separate reviewer context and retain immutable PASS review bytes/digest; a changed candidate requires new verification/review.
- [ ] Use explicit Governor-authorized integration/delivery requests. Verify integrated ref, App-owned successful Checks, exactly one draft PR and GitHub readback of expected SHA, base, repository and review identity.
- [ ] Commission authenticated owner-HTTP cancellation and process-death/restart on controlled nonbillable deployment-shaped tasks. Require abort propagation, no late delivery, exact absence or retained UNKNOWN, correct spend/capacity and no replay. Do not destroy the sole live result to stage a demo.
- [ ] Acceptance: one genuine owner-approved-task -> metered builder -> admitted candidate -> independent certificate/review -> integrated ref -> draft PR, all linked by durable events/digests. Owner can inspect/cancel; final merge remains owner-controlled. This is the first operator-assisted milestone, not full autonomy.

### P1-A — Automate approval-to-dispatch (depends on P0-D; one schema owner)

**Files:** new `apps/control-plane/src/approved-dispatch.ts`; `server.ts`; worker trusted launcher adapter; `packages/contracts/src/{mission,sql-mission-store,memory-mission-store}.ts`; new `db/migrations/011_approved_dispatch.sql`; focused dispatch tests and actual PostgreSQL tests.

**Interface:** a committed immutable dispatch intent binds mission/plan/slice/epoch, policy/images, scope, ceilings and expiry. A private trusted dispatcher consumes it and wakes the existing worker. The browser/API handler never runs Docker, holds provider secrets or substitutes for worker atomic claim.

- [ ] Write PostgreSQL concurrency/restart tests before implementation: repeated approval, crash before/after launch acknowledgment, racing dispatchers, cancel-before-claim, expired intent and UNKNOWN receipt.
- [ ] Add a transactional durable intent/outbox to approval; use the existing worker targeted claim and service lock. Unique identity is mission + approved plan digest + slice + epoch. Record external dispatch intent before any possible launch.
- [ ] Acceptance: all race/restart cases yield at most one builder execution; ambiguous dispatch is quarantined and reconciled, never retried blindly. One normal browser approval launches eligible approved work without a private hand-written task file. Disabled mode still queues without execution.

### P1-B — Automate independent review and guarded draft delivery (depends on P1-A)

**Files:** new `apps/control-plane/src/review-request.ts`; reviewer adapter/service; typed review-request store and next migration; existing `certified-handoff.ts`, controller authorities and delivery code. Assign shared schema changes serially.

- [ ] Persist an idempotent review request only for the observed certified SHA/tree/epoch/check/evidence binding. A separate reviewer receives objective, diff and trusted outputs without builder reasoning or authority credentials.
- [ ] Persist PASS/FIX/ESCALATE plus immutable review bytes; builder identity cannot sign its own review. FIX becomes a bounded new repair decision only within explicit remaining approval/budget; otherwise pause for the owner.
- [ ] Invoke existing integration/draft delivery only after fresh Governor checks and preauthorized delivery policy. Reconcile lost GitHub responses by remote readback; do not synthesize PASS or create duplicate branches/PRs.
- [ ] Acceptance: normal approved missions reach one certified/reviewed draft PR without manual JSON or process restart; changed head, stale review, cancellation, denied review and lost acknowledgments all block or reconcile correctly. No automatic merge/deploy. Owner UI exposes review, checks, diff, spend, cancel/escalation and exact draft URL.

### P2-A — Activate planning, dependency scheduling and bounded recovery (depends on P1-B)

**Files:** introduce `packages/orchestrator/` for the canonical Athena/Sol composition; reuse `packages/contracts/src/scheduling.ts`, `packages/governor`, `apps/worker/src/poll-pool.ts`, `packages/judgment` and `packages/stuck-resolver`; extend approved-service single-task contract only in a separately reviewed packet.

- [ ] Sol planning produces a typed proposed DAG, acceptance/checks/scopes/dependencies/budgets; owner approval freezes that plan. Model replans cannot expand scope or authority without owner approval.
- [ ] Wire existing deterministic scheduling first, then bounded Jev advisory adapters with exact model allowlists, measured usage and fresh Governor checks. Neither web nor worker entrypoint currently composes live Jev scheduling/recovery/learning adapters.
- [ ] Prove two disjoint READY slices concurrently, dependent and overlapping slices serially, integration conflict handling and one-lane fallback. Scale toward six only with measured host/capacity/quota/budget evidence; do not invent work to fill lanes.
- [ ] Wire repeated-error/stagnation detection to finite strategies, checkpoint executor and bounded materially different repairs; exhausted budget or uncertain effects pause/escalate.
- [ ] Acceptance: a real approved multi-slice mission satisfies dependencies and scopes, bounded live Jev decisions are retained, stuck recovery changes strategy and terminates, cancellations fence all lanes, and final integrated SHA is independently reverified/reviewed before delivery.

### P2-B — Validate learning, truthful Loom and production recovery (depends on the live paths above)

**Files:** reuse `packages/learning/src/{activation,challenger,lesson-policy}.ts`, durable episode/lesson stores; `apps/control-plane/src/{loom-projection,loom-page,owner-readiness}.ts`; private backup/monitoring/operator procedures.

- [ ] Bind live episodes and failed attempts to decisions/actions/outcomes/metrics. Challenge scoped candidate lessons independently, promote only under existing policy, apply to a later comparable task and withdraw on contradiction.
- [ ] Acceptance for learning: retained matched baseline/strategy cohorts, explicit attribution, measured time/cost/quality/recovery metrics, observed downstream policy change and successful withdrawal. A fixture demonstration or better unpaired run is not measured improvement.
- [ ] Reconcile real mission/agent/check/review/delivery/recovery/learning events into the approved Loom; refresh/reconnect/replay must reconstruct the same state and exact file/commit evidence. Implement remaining canonical source/dependency/requirement evidence links with explicit inferred/unavailable labels.
- [ ] Acceptance for operations: encrypted off-host restore exercise, exact evidence retention/digest checks, expired credential/capacity behavior, host/DB/process recovery, billing/usage observability and actionable owner alerts. No stale green health/completion state during outages.

## Finish-line acceptance and immediate execution order

Complete P0-A -> P0-B -> P0-C -> P0-D -> P1-A -> P1-B -> P2-A -> P2-B. Within P0, secure credential setup and read-only cost/host inspection can proceed independently; share no mutable schema, release or external-effect ownership.

The autonomous product is complete only when a new owner objective can be planned and approved, dispatched without operator glue, built under deterministic limits, recovered or escalated safely, independently verified/reviewed, integrated and delivered as a read-back-confirmed draft PR; owner controls final merge/release; evidence survives restart and reconstructs truthful UI state. Canonical live Jev, useful bounded concurrency, challenged learning and measured comparable outcomes, security and recovery obligations remain part of product acceptance. A single successful assisted PR closes P0-D only.

Immediate tasks: finish the narrowly scoped P0-A source repair and review; integrate it with recovered `dfc06fd` in one successor; then qualify exact v10 images and compatible Hostinger release. Do not spend another paid builder attempt diagnosing defects already reproducible without one. Retain all negative evidence and label each result as implemented, locally validated, deployed or observed live.
