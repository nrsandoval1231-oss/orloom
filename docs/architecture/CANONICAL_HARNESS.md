# Orloom — Canonical Autonomous Creation Harness
**Status: AUTHORITATIVE TARGET — 2026-10-21.** Replaces the mistaken one-agent architecture reset. Do not infer runtime readiness from design documents.

## Execution architecture
Owner intent → high-reasoning product architect → executable product specification and dependency-aware work graph → up to six fast builders in isolated workspaces → deterministic integration → independent high-reasoning quality director → test, preview and critique → targeted repair and refinement loops → working product, evidence and reviewable PR/deployment handoff.

## Responsibilities
1. **Product architect:** Refine sparse instructions into an ambitious yet coherent product, explicit scope, user journeys, acceptance criteria, architecture and independently buildable interfaces. May improve the idea without inventing user authorization for irreversible actions.
2. **Scheduler/controller:** Durable queue, dependency graph, scope ownership, bounded parallel scheduling, cost/time limits, events, cancellation and safe recovery. Prefer deterministic code. No approval committees for routine work.
3. **Six fast builders:** Default pool target; allocate useful independent tasks; each has its own checkout, scoped inputs and resources. Avoid overlapping edits, oversubscription and costly coordination. Builder provider/model is replaceable and must be operationally verified.
4. **Integration:** Combine actual changes, resolve conflicts, rerun affected and end-to-end checks; never treat six passing isolated tasks as a completed integrated product.
5. **Independent quality director:** Strong model with independent context examines architecture, running UI, user journeys, accessibility, defects and design quality; creates concrete, prioritized repair tasks. Ground critique in observed behavior and evidence.
6. **Recovery:** Diagnose failed commands, bad edits, stalls and integration errors; vary strategy and retry within finite limits, escalating when blocked.
7. **Verified learning:** Retain concise reusable lessons with source evidence and measured outcomes; promote or retire based on repeated comparable results, not AI confidence.
8. **Delivery:** PR with source SHA, tests, screenshots/preview when relevant, known gaps, costs and run history; production deployment only with explicit or narrowly predelegated authorization.

## Simplicity rule
Complex intelligence behind a simple UI. Remove duplicate governors, advisory agents, mandatory manual slice approvals, policy-document bureaucracy and disconnected subsystems. A single small deterministic controller may enforce safety and coordination. Keep high-value architect, builders, critic and improvement loop. Optional tools such as Jev or Athena must prove they improve delivery before becoming critical-path dependencies; names are not architecture.

## Real safety boundaries
Isolate untrusted code from control-plane secrets; restrict provider and GitHub credentials; use scoped tokens, finite execution limits, durable cancellation, interruption fencing and safe retries. Checks must not be rewritten by the candidate under test. Preserve truthful state and owner authority for merges, secrets, spending ceilings and deployment.

## Product acceptance sequence
1. Demonstrate one real coding agent edits a controlled repository in an isolated environment, tests and opens a PR. Record live evidence.
2. Demonstrate two concurrent builders, isolated and integrated correctly.
3. Demonstrate six independent builders with measured throughput, contention and cost.
4. Demonstrate the architect turns a generic prompt into a product specification and working build.
5. Demonstrate independent quality critique finds real defects and causes observable improvements.
6. Demonstrate bounded autonomous recovery, self-improvement across comparable runs and a complete runnable application/preview.
7. Demonstrate full unattended mission completion within authority, budget and time limits.

No claim of completion from fixture tests, static source inclusion, agent messages or animations. Do not skip operational acceptance to add more subsystems.

## Repository cleanup
Keep runtime code until dependency-mapped and regression-tested. Retire obsolete documents and duplicate orchestration in reviewable batches. Preserve historical evidence where useful, but archive it outside active instructions. Never delete a capability solely because the prior simplification PR called it unnecessary.

## Success
A user asks for an app and receives an unexpectedly thoughtful, polished, tested, usable product quickly, with minimal owner intervention and inspectable evidence.

## Frictionless operation and autonomous decision rights — 2026-10-21
- Onboard once: securely connect GitHub with a scoped App/OAuth grant; persist an authenticated owner session. Routine missions must require no copied tokens or repeated password entry. Refresh short-lived installation credentials server-side. If credentials lapse, present a normal reconnect action instead of a terminal/secret ceremony.
- Accept either an empty or established GitHub repository. Inspect repo state and conventions. For empty repos scaffold structure, code, package/dependency definitions, tests, assets, build and preview/deployment configuration automatically. Do not require the owner to manually initialize directories or files.
- Generate, version, and continuously consult a canonical mission PRD from the original intent. The architect can refine features, visual identity and implementation approach autonomously. The critic tests the integrated result against product acceptance and PRD. Maintain a distinct record of changes to intent; do not silently move goalposts.
- Owner delegates routine actions within a session/account-level policy; do not ask permission for each commit, branch, task, agent allocation, design choice, retry, or test. Sensitive scopes (external spending beyond cap, destructive data changes, privileged external services, production deployment without preauthorization) require explicit authorization.
- Every mission has durable journal/checkpoints, finite retry/tool/cost ceilings, heartbeat and detection of no progress. When blocked: classify failure, inspect context and PRD, select materially different safe repair, rerun targeted tests, replan dependency graph, route work to another builder or pursue independent tasks. Integrator resumes from last verified checkpoint.
- Prevent apparent motion without progress: hash/compare repeated failures and diffs; stop repeated identical unsuccessful strategies; escalate to architect/critic for alternate design; preserve evidence and safe state. After all admissible strategies or budget are exhausted, surface a specific actionable blocker and preserve all work. Never imply infinite autonomous recovery is guaranteed.
- Make completion user-facing: verified runnable preview/deployed application when authorized, working access details, concise summary and optional repository/PR inspection. A PR alone is not the promised final UX.
