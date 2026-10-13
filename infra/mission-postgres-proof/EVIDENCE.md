# ORL-PG-001 — real PostgreSQL mission-store evidence

## Candidate and scope

The proof ran against the frozen ORL-005A source manifest SHA-256 `c418a11e1e616eda7d1005c45a317082013d2c9923883f9dd58ed92bf414b287`, branch `feat/canonical-mission-execution`, base/HEAD `41643d8b210c98dd5b8b870e79f5a9902c83882b`. The complete source manifest is retained in `candidate-manifest.sha256` and contains 24 scoped files. The compiled allowlisted test bundle contains 136 files; its manifest SHA-256 is `5840ff1f91c4c4c9b2757a24e2956ffb9fadc693662d59e6b86a8ad0ffb6de97` (`bundle-manifest.sha256`). Both files are checked by the controller repeat helper before it resets or runs anything.

Relevant frozen source SHA-256 values:

```text
d0a146611e5d459f61652818dc3f41264c15fc5d621eb2d5cb2d4c1486138714  packages/contracts/src/sql-mission-store.ts
afbf320aecba47d0531c85f9368a70217a11e1aa7809e7bb39c163c27fb5511d  packages/contracts/src/postgres-store.ts
ff481d7c4049fecdebaf72eae2b6b7d802716e05da2d33a83da1e9c65fc6c783  packages/contracts/src/sql-store.ts
3792c72002c6957a9f11435247d382a56a4f5061d511bc106facbc56fc9b74c5  packages/contracts/src/mission.ts
1240cb8af48ced5f678bfe5cef2d004c53a1964ee0b0e2721614dc81051741f4  db/migrations/001_initial.sql
1f13013e5944a78c67d5dd1c7bea163bf6a6e4f9216d528ba8091ee9882f55ab  db/migrations/002_missions.sql
115f66e282fcbab458baee3705357c9c464ce692df2b2dfccb36a0fa36985d32  tests/missions.test.ts
```

## Runtime proof

On dedicated host alias `codex-dark-peak-5042`, the proof used a disposable PostgreSQL 17 Alpine image pinned as `postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` and the existing Universal image pinned as `ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304`. The DB had 0.5 CPU, 512 MiB, 64 PIDs; the test container had runsc, UID 65532, read-only root, cap-drop ALL, no-new-privileges, 1 CPU, 768 MiB, 128 PIDs. Both were on the packet-labeled internal-only Docker network, with no published ports or host binds. PostgreSQL data and 0400 password files used dedicated Docker-managed volumes; password mounts were read-only. No password values were output or placed in container environment values.

The real PostgreSQL pool proof passed twice against this manifest and bundle: first by the builder, then by the controller’s independent reset-and-rerun helper (helper SHA-256 `cc9fe8755b8dfd3aa0492c74b4367f40dff70dcfa311ac3971af2147b2ef3c1a`; exit 0). It reported:

```text
PASS PostgreSQL migrations and readiness
PASS real concurrent PostgreSQL sessions=8
PASS concurrent claims are distinct and capped at six
PASS event history and migrations persist across pool reconnect
PASS same slice cannot be claimed twice concurrently
PASS dependency-waiting child does not quarantine its ready overlapping parent
PASS mixed-case repository names share canonical scope exclusion
PASS failed recommendation rolls back all plan, slice, and event writes
PASS expiry marks UNKNOWN, retains reservation, and quarantines its slot and scope
POSTGRES_MISSION_PROOF=PASS
```

The tests use separate PostgreSQL pool connections, persist and replay event cursors after closing/reopening the pool, race parallel claims, and verify rollback and quarantine behavior. The claims are application-level database proofs; this does not establish capacity for six live worker processes or end-to-end provider lanes.

## Reproduction and limits

Before teardown, after verifying all packet labels, exact container/network IDs, pinned images, no-port/no-bind metadata, secret mount modes, and both manifests, the helper reset only the `public` schema in disposable database `mission_proof` and reran the exact frozen test bundle:

```sh
ssh codex-dark-peak-5042 'bash /var/lib/orloom/mission-postgres-proof/rerun-proof.sh'
```

The controller repeat helper (hash listed below) and staged bundle were removed from the host after the successful repeat and teardown. Their scripts and manifests remain in this local evidence packet; the source-bound bundle can be reconstructed with `refresh-payload.cjs` against the retained frozen manifest. The compiled dependency payload and staged Node binary were removed after proof. The first test run found that runsc could not resolve Docker's embedded container DNS name (`EAI_AGAIN`). The tested private DB address was obtained from Docker inspection and passed through the nonsecret test-only `ORLOOM_PG_HOST=172.19.0.2`; this does not test product DNS or alter source behavior. Failed attempts and repairs are retained in `ATTEMPT-01.md`, `ATTEMPT-02.md`, and `ATTEMPT-03.md`.

Key local packet artifact hashes:

```text
337f11487dc67e927f417434f5c38cc9867a83ca84ec6ce19ec26ef1e41c035b  postgres-proof.mjs
0e0c12bba0623925e2b6afddccbc921e39c0bd1c9efb996e671dd9137dfdf648  reset-proof-db.mjs
d829b01dc547f3aed5e3842ef569b35af1b47146e0b7f3c7697b18be05182d8c  refresh-payload.cjs
cc9fe8755b8dfd3aa0492c74b4367f40dff70dcfa311ac3971af2147b2ef3c1a  rerun-proof.sh
9fb570b6e429427ff2888996aff2171bba9b80e82a98f3cd5ad9f1152b58b581  cleanup-disposable.sh
```

No token measurement was available (`UNKNOWN`). No new paid resources or provider calls were used.

This is a disposable real-PostgreSQL proof only. It did not connect to production/Hostinger, call a provider, execute a worker, or establish product readiness. Full six-live-lane capacity and remote database operations outside this proof remain `UNKNOWN`.

The exact two labeled containers, their dedicated data/secret volumes, and the exact internal network were removed at 2026-10-13 03:23 UTC. Follow-up inventory found zero packet containers, networks, or volumes. At 03:25 UTC the owned remote packet staging directory `/var/lib/orloom/mission-postgres-proof` was removed after verifying its canonical path, root ownership/mode, expected five top-level entries, and absence of packet Docker resources. Protected `codex-universal` remained running with the same ID and StartedAt, restart count 0, runtime `runc`.
