# ORL-004 Hostinger queue-only control plane

- Node: ORL-004; base: `ccc78ab5975c7f8bee20b52a74eb48ca45cffb51`; branch/worktree: current clean main checkout.
- Objective: provide a queue-only cloud control plane backed by PostgreSQL and an operable Hostinger Compose deployment; no workers or execution.
- Allowed: control-plane app, config, PostgreSQL adapter/migration readiness, package manifests, affected tests, `deploy/hostinger`, control-plane Dockerfile, `.env.example`, security/deployment docs, this packet and completion/evidence artifacts.
- Excluded: `.agent/CURRENT_STATE.md`, `.agent/WORK_GRAPH.md`, canonical vision/PRD/architecture, worker/SDK/providers, schema changes absent a demonstrated defect, secrets, external writes/deploy/push/commit.
- Invariants: cloud requires DB URL, session token and explicit public HTTPS origin; fail closed. Cookie contains random opaque expiring session identifier, never configured token; cloud cookie HttpOnly/Secure/SameSite=Strict. Mutations require fixed Origin and validated Host. Never log credentials. Local behavior remains usable. PostgreSQL migrations/readiness are idempotent. Compose exposes app only through configurable external Traefik network/router/TLS resolver and keeps DB private. Queue only; no execution path.
- Acceptance: deterministic auth, CSRF, cookie expiry and PostgreSQL adapter/readiness tests; documented backup/restore and serial deploy/rollback; rootless/read-only/container limits/log rotation/healthcheck; secrets via ignored external files, excluded from image. Gates: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run validate`, `git diff --check`.
- Authority/risk: local reversible implementation only; no external side effects, credentials, paid services or deployment.
- Retry budget: two materially different repairs; checkpoint if host/architecture boundary changes.
- Handoff: exact changed paths, base/final SHA, commands and exit codes, runtime/external UNKNOWNs, UTC metrics with token usage UNKNOWN. Controller owns graph/current state/review.
