# Orloom — Canonical Engineering Harness

Status: architecture decision record. This document specifies the target system; it does not assert implementation or operational readiness.

## Mission
Orloom is a commercial cloud-native autonomous software engineering platform. Start with a single owner and GitHub repositories. Convert an approved engineering objective into verified, integrated code and a GitHub pull request. Speed means time to verified integrated functionality, not token volume, agent count, or commits.

## Non-negotiable architecture
- GitHub is source control, branch and PR delivery. GitHub Actions is NOT the CI executor. Orloom executes checks on its own isolated DigitalOcean workers and may publish commit-specific GitHub Checks API results.
- Cloudflare web edge; PostgreSQL durable state and work scheduling; R2 evidence and artifact storage.
- Separate deterministic Governor from model judgment. Only Governor authorizes side effects, budgets, credentials, merge/push, run transitions and approvals. Never place control-plane credentials in build sandboxes.
- Athena: mission orchestrator, dependency-aware critical-path scheduler and cross-slice coordinator.
- Sol: lead architect, interface contracts, dependency graph and architectural replanning.
- Jev: shared bounded adaptive decision engine, implemented once under `packages/judgment/` with the verified official TypeSafe SDK/runtime. It selects only among finite authorized alternatives using mission state, dependency/critical-path context, capacity, evidence, promoted lessons and approved budgets. Athena remains the scheduler; Jev is neither another builder nor an unrestricted orchestrator.
- Every Jev recommendation must pass a fresh deterministic Governor check before execution. Jev cannot alter permissions, budgets, scopes, required verification, merges, lesson promotion or the owner objective, and cannot issue arbitrary commands. Record decision identity, policy version, evidence, authorized action and measured outcome. Noncritical decisions may use explicit deterministic fallback; uncertain effects or authorization/evidence failures fail closed.
- Elastic pool of DeepSeek builders: configure six concurrent lanes initially, scale by independent work, quotas, throughput and budget. Every lane uses an isolated checkout/workspace and bounded permissions. Production model identifiers and API availability must be verified before activation.
- Independent adversarial reviewer (Astra role, configurable provider) with separate context and verification evidence.
- Stuck Resolver: repeated-error, near-identical patch, stagnation, blocked dependency and integration-conflict detection; diagnose, change strategy, replan or escalate under bounded policy.
- Continuous Learning Engine: extract lessons during each slice, preserve provenance and checks, compare comparable outcomes, publish versioned relevant lessons to subsequent slices and controlled checkpoints, withdraw contradicted lessons. Slice 10 should benefit from earlier lessons; improvement is measured, not assumed.
- Orloom CI: affected checks during work; final independent clean-workspace build, tests, quality/security checks and evidence anchored to exact commit SHA. Any head change invalidates certification.
- Living circular Loom: visualizes real mission, agent, dependency, drift, progress, verification and learning events; never invents completion or activity.
- Preserve Intent → Plan → Implement → Verify → Learn → Update as the canonical engineering loop.

## Revised integration boundary (2026-10-13)

PR #2 is frozen at `8bbcfffbf631e5ad2972e34b41284198afc566e2`. Do not modify, merge, rebase, close, or continue that broker implementation. Develop independent components from main after PR #1's verified integration. Preserve the existing broker exactly; do not create a competing DeepSeek broker. Versioned progress and decision contracts may be added to the control plane independently, without claiming the frozen broker consumes them.

Recovery follows Detect → Diagnose → Jev Strategy Selection → Governor Authorization → Execute → Evaluate, with materially different approved strategies, bounded attempts/budgets, durable outcomes and Sol escalation when needed. Interrupted effects retain UNKNOWN quarantine.

Engineering episodes and lessons distinguish candidates from independently challenged, policy-promoted versions. Repeated comparable evidence, contextual relevance, attribution, metrics and withdrawal conditions govern promotion. Jev may select relevant promoted lessons; it cannot promote them. Subsequent comparable work must follow an observably changed authorized strategy, and contradictory evidence must be able to withdraw it. Fixture demonstrations do not prove live speed, quality or cost improvements.

Execution order after PR #1: shared judgment gateway and Governor integration; active recovery; continuous learning; Athena scheduling improvements; independent Orloom CI; integration and evidence-backed PR delivery; actual-event Living Loom; cross-component cloud recovery. Product-generated PRs require owner authorization to merge. Source implementation, deterministic behavior, live provider execution, cloud deployment and independently certified outcomes are separate acceptance states.

## Engineering execution lifecycle
1. Capture mission, repo, immutable base SHA, objective, acceptance criteria, constraints, budgets and owner approvals.
2. Architect decomposes into slices with dependency graph, interface contracts and expected checks.
3. Athena schedules independent slices concurrently on DeepSeek builder workers; serialize conflicting writes and dependency-bound integration.
4. Each builder streams durable events, checkpoints, diffs, commands, evidence, cost and status.
5. Stuck Resolver intervenes on non-progress with bounded repair/replan. It must not loop indefinitely.
6. Learning Engine publishes verified, scoped lessons across slices with immutable versioned provenance and rollback.
7. Integration coordinator combines compatible changes, resolves conflicts and reruns affected checks.
8. Independent verification in a fresh isolated workspace evaluates exact head and objective; adversarial reviewer inspects diff and evidence.
9. Governor certifies only if policy and evidence pass, publishes results to GitHub, and creates a PR; owner retains final merge authority by default.

## Speed and quality requirements
- Optimize critical-path completion and useful concurrency, not fixed maximum parallelism.
- Warm base images, dependency caches and streaming event delivery without sharing unsafe execution state.
- Incremental affected checks plus mandatory clean final verification.
- Adaptive resource and provider allocation within owner-approved limits.
- Measure time-to-verified-PR, completion rate, integrated slices per hour, cost per verified change, stuck recovery success, human interventions, regression rate and improvement across comparable slice cohorts.
- Learning effectiveness requires controlled comparison and withdrawal on harm; do not claim every subsequent slice is automatically better.

## Repo layout target
apps/web — owner interface and Loom
apps/api — control plane and event API
packages/contracts — typed mission, slice, event and evidence contracts
packages/governor — deterministic policy and authorization
packages/orchestrator — Athena scheduler and Sol planning
packages/judgment — shared typed Jev decision gateway
packages/agents — provider adapters and DeepSeek worker pool
packages/stuck-resolver — bounded diagnosis and recovery
packages/learning — lesson lifecycle and comparable-outcome evaluation
packages/integration — branch/worktree coordination
packages/verification — Orloom CI and independent review
packages/loom — real-event visualization projection
workers/executor — isolated cloud execution runtime
infra — DigitalOcean, Cloudflare, PostgreSQL and R2 definitions
docs/architecture — architecture decisions and threat model

## Security and operations
Use a secrets manager for provider API keys, GitHub App private keys, database credentials and Cloudflare/DigitalOcean credentials; never commit or paste secrets into source or docs. Use short-lived scoped credentials and isolated workers. Record audit events and recover interrupted jobs using durable leases/fencing. Protect against untrusted repository scripts, prompt injection and credential exfiltration. Do not infer production readiness from unit tests or synthetic visuals.

## Reuse boundary
Aura and forge-agent are reference repositories, not automatic code imports. Preserve their valuable concepts (Athena/Sol, Governor, DeepSeek lanes, StuckDetector, LessonStore, bounded learning, independent review), but inspect implementations and interfaces before selectively reusing anything.

## Delivery principle
Build the full coherent product architecture without artificial feature deferral; use vertical integration and executable acceptance criteria so the system delivers real engineering outcomes rather than endless agent activity.
