# ORL-005A Build Packet

Objective: implement an authenticated, durable mission submission and governed scheduling spine on `feat/canonical-mission-execution` at base `41643d8b210c98dd5b8b870e79f5a9902c83882b`.

Allowed ownership: `packages/contracts/**`, `packages/governor/**`, `packages/athena/**`, additive `db/migrations/002*`, `apps/control-plane/src/{server,main}.ts`, `packages/config/src/config.ts`, affected tests, `README.md`, `docs/FINISH_CONTRACT.md`, `docs/security.md`, `docs/deployment.md`, `.agent/MISSION-*`. Do not modify prototypes, worker/SDK/provider code, `CURRENT_STATE.md`, `WORK_GRAPH.md`, Aura/forge-agent references, deployment/remote state, or Git history.

Dependencies: ORL-004 queue-only service and canonical `docs/architecture/CANONICAL_HARNESS.md`, `docs/LIVING_LOOM_CANONICAL.md`, `docs/FINISH_CONTRACT.md`.

Invariants: missions immutable on repository/base SHA/objective/acceptance/budget; six configurable lanes maximum, default enabled capacity 0; plan recommendation and owner approval are separate; deterministic governor is sole transition authority; PostgreSQL is durable authority; dependency and overlapping scope serialization; fencing epoch/token; expired running work remains UNKNOWN; worker cannot certify verification/integration; verification stays closed with no endpoint in A; capability scoped to a lease; budget reservation fail-closed; events replay from durable cursor; preserve job routes; no synthetic Loom activity or external effects.

Acceptance: authenticated HTTP submission and plan approval/replay; validated DAG and scope ownership; transactional PostgreSQL scheduling/leases; explicit verification boundary; owner UI consumes actual mission API; PGlite/HTTP/concurrency/security tests. Run npm ci, typecheck, test, build, validate, diffcheck. Real PostgreSQL, deployment, and live worker runtime remain UNKNOWN.

Authority/risk: local implementation only; no commit/push/deploy. Security/governance critical. Retry budget two materially different repairs. Completion handoff includes changed files, exact candidate, commands/exit codes, and honest UNKNOWNs.