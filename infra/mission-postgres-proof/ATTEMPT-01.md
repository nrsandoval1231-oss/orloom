# Setup attempt 01

- UTC: 2026-10-13 (during ORL-PG-001 preparation; exact start minute not recorded).
- Scope: only ORL-PG-001 network, DB/test containers, data volume, and secret volume on `codex-dark-peak-5042`.
- Outcome: database readiness failed; the setup script exited nonzero. The PostgreSQL container exited 1 with the sanitized entrypoint message that `/run/secrets/pg-password-db` was absent. The test container remained alive pending diagnosis.
- Cause: the initial named volume used the Docker local driver backed by `type=tmpfs`. Docker mounts a new tmpfs for each container attachment, so the writer's file did not survive its container exit. No password bytes were emitted or read back.
- Exact objects observed before repair: DB container `6c913a2aa78b4cc9e4889aeb8687731102d98461355b6979538d4424dd28711f`; test container `acdf53bdb27221b2dccc8c3313e8a78f811600034caa6e6e3d1c63211698b921`; network `orloom-pg-proof-20261013-net` (`internal=true`, packet label ORL-PG-001); volumes `orloom-pg-proof-20261013-data` and `orloom-pg-proof-20261013-secrets`. Containers used only their pinned intended images; neither had published ports or host binds.
- Controller approved repair: replace only the secret volume with a dedicated temporary Docker local volume; preserve owner-restricted mode-0400 copies, read-only DB/test mounts, and exact-name cleanup. Failed objects are removed before a single bounded retry.
