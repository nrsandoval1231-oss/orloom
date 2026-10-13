# ORL-004 controller runtime evidence

Verified 2026-10-13 UTC. Exact repaired candidate manifest SHA256: 04759a85db512b330db56050365a3a504c0ce861e7aac6918680b8784ec85e76. Independent Sol PASS after repair1; original FIX preserved. All 16 implementation files matched on remote host. Base ccc78ab5975c7f8bee20b52a74eb48ca45cffb51.

Controller npm ci, typecheck, test (14/14), build, validate and diff check all exit0. Remote Compose config and image build exit0. Image sha256:1cbf54112ae4429649302f0ef533e9df7b79124bad9fdeb45a52de7932918cec. PostgreSQL image sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193.

Dedicated /opt/orloom deployment, compose project orloom. Services orloom-app-1 and orloom-db-1 healthy. Public URL https://orloom.srv1758862.hstgr.cloud . Host secrets generated without printing, separate app DB role nonsuperuser; existing app_password metadata narrowed to UID70 mode0400. First-boot proof in isolated tmpfs PostgreSQL succeeded with restricted secret; test container removed. PostgreSQL has no published ports and only orloom_database internal network. App UID10001 read-only filesystem, no host socket or admin DB password mount.

Actual image PostgresJobStore connect/migrate/submit/close/reconnect/read passed. HTTPS health and authenticated queue submission passed, foreign Origin403, random Secure/HttpOnly/Strict cookie not equal to configured token. Stop app/restart PostgreSQL/start app/relogin recovered same queued proof row. Logical backup restored into separate orloom_restore_proof database; exact IDs/status/repository/task matched original. Two synthetic proof rows only. Backup remains host-restricted at /opt/orloom-ops/backups/initial-proof.dump; off-host encrypted scheduled backup NOT configured. No customer workloads authorized on this initial queue-only slice.

Existing nine container IDs, started timestamps, restart counts unchanged versus preflight. n8n HTTPS health200. Existing baseline includes GridLens scanner and qdrant not shown by Hostinger seven-container app summary.

Browser automation opening failed net::ERR_BLOCKED_BY_CLIENT; no bypass attempted. Independent Windows HTTPS homepage200 and health cloud/liveExecution:false; remote authenticated HTTPS checks passed. Interactive browser acceptance remains UNKNOWN. Runtime evidence is bounded queue-only deployment, NOT full product completion or coding-job readiness. DO worker, GitHub App, R2 runtime, Forge scheduler and off-host backup integration remain separate gates.

Repairs:1. Lane:full. Builder Luna low; reviewer Sol medium. Start approximated by packet timestamp only, exact phase durations and total token usage UNKNOWN. Do not infer speedup or full acceptance while interactive browser gate remains open.
