# ORL-004 deterministic evidence

- Base: ccc78ab5975c7f8bee20b52a74eb48ca45cffb51.
- Candidate manifest: .agent/HOSTINGER-CANDIDATE.json; file SHA-256: 9684dd84434976937c0f55d4aafe26d1e09240a917866a1ff2e225332be75c62.
- Node v24.21.0; npm 11.19.0.
- npm ci: exit 0, 99 packages audited, zero vulnerabilities.
- npm run typecheck: exit 0.
- npm test: exit 0, 14 passed, 0 failed. Includes opaque/secure/expiring cloud session, Origin/Host rejection, cloud config fail-closed, and unreachable PostgreSQL startup rejection.
- npm run build: exit 0.
- npm run validate: exit 0.
- git diff --check: exit 0; Git emitted only CRLF normalization warnings for working tree files.
- Local Docker runtime unavailable; Compose syntax/image build, live PostgreSQL migration/readiness, persistence across restart, backup/restore, TLS and browser behavior are UNKNOWN and delegated to controller validation. No deployment or external write was performed by builder.
- Tokens, start time, and per-phase durations: UNKNOWN. Finish UTC: 2026-10-13 01:09:40 UTC.