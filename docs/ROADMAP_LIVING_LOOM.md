# Roadmap — From Visual Prototype to Real Orloom
Status: forward plan, not a claim of delivery.

## Existing foundation
Orloom ORL-001 is a local queue-only control-plane foundation with typed provider seams, a PostgreSQL schema exercised through PGlite, and a worker placeholder. It is not live cloud execution. See docs/FINISH_CONTRACT.md and README.md for current facts. GitHub Actions are intentionally not the CI engine.

## Milestones
### 0. Preserve prototypes and design (now)
Store canonical docs, standalone V1–V4 references, and versioned screenshots when available. No production/harness coupling.

### 1. ORL cloud execution foundation
Secure single-user cloud auth, persistent PostgreSQL, GitHub App installation flow, isolated DigitalOcean workers, lease/reconciliation API, R2 evidence storage, trusted Forge-owned validation, operational recovery, bounded provider costs, cloud deployment. Commission against a disposable repository before claiming live readiness.

### 2. V5.1 — Real telemetry
Read-only event adapter from Orloom's durable run log into Living Loom. Show real agent activity, run status, candidate IDs, replay, reconnect, no synthetic/live mixing. The adapter must not control the harness.

### 3. V5.2 — Real code topology
Parse actual repositories, source symbols and dependency graph, map into five sectors. Clicking a bundle shows file/line/commit identity. Inferred relationships are labeled.

### 4. V5.3 — Verified Purpose Graph
Versioned requirements, constraints, code links, independent acceptance evidence, genuine weighted coverage and evidence-backed drift. The circle closes only when approved scope is verified.

### 5. V5.4 — Athena/Jev intelligence
Real bounded Jev decisions with host authorization; Athena outcome evaluation, policy lineage, independent challenge, and contextual recommendations. Keep Athena reusable and separate from Orloom runtime.

## First live Loom demo acceptance
- A real disposable coding run starts and activates an agent node.
- Source changes become inspectable with exact commit identity.
- Independent validation creates a candidate-bound evidence event.
- Replaying retained events reconstructs the same visual state.
- No fabricated percentages or fake live activity.
- No bypass of authorization, spending, or merge gates.

## Sequencing constraints
Do not attach V5 to an unstable worker/event contract. Stabilize the execution foundation first, then add a read-only event projection. Avoid new databases, agent runtimes, and needless platform dependencies.

## Suggested next implementation slice
Write an architecture ADR for the immutable event schema and a deterministic projector that consumes a recorded synthetic/fixture event log. Add replay/idempotency tests. Then wire the same projector to genuine Orloom events after the worker and verification contracts are stable.
