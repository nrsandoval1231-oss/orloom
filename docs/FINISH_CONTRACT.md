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

## The live Orloom product is not complete

Remote deployment, production PostgreSQL, production session hardening, GitHub App installation flow, worker lease API, disposable isolated worker implementation, network/credential confinement, Forge scheduler and trusted CI execution, audit retention, monitoring, backups, and recovery have not been built or proven. The GitHub and R2 adapters exist but have not made live requests. Docker engine availability and container isolation runtime proof are `UNKNOWN`. A successful ORL-001 gate must not be described as live readiness or completion of the product objective.
