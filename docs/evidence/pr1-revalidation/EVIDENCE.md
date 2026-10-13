# PR1 local gates and PostgreSQL runtime revalidation

## Candidate identity

- Requested detached worktree: `work/orloom-main-review`.
- Identity observed before validation and payload generation: `2d45b64e24817a14826a6c9466145909680fec0b`, clean detached HEAD.
- Package lock SHA-256: `8969f1cd59b72f7832bd8ced96a49fdfddb4ed0eaf84768a21ab3b92d001d02f`.
- Candidate identity record SHA-256: `d9ef0cfc73b955bee9b687724d29c95a667e3b14b1d387d54dd9cc2aab2d36a1`.
- Allowlisted compiled PostgreSQL proof payload: 140 files; manifest SHA-256 `2ac74b88818440a9e7778808bb1629853cf743418239c960849e17d77f1253df`.
- Proof source SHA-256: `337f11487dc67e927f417434f5c38cc9867a83ca84ec6ce19ec26ef1e41c035b`; schema reset helper SHA-256 `0e0c12bba0623925e2b6afddccbc921e39c0bd1c9efb996e671dd9137dfdf648`.

## Deterministic gates

Executed in the clean `2d45b64` worktree, in order:

| Command | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | 98 packages installed; audit reported 0 vulnerabilities |
| `npm run typecheck` | 0 | PASS |
| `npm test` | 0 | 21 passed, 0 failed; includes build |
| `npm run build` | 0 | PASS |
| `npm run validate` | 0 | Foundation structure validation passed |

All five proof shell scripts passed `bash -n`. After this sequence, a read showed no tracked/untracked changes in the target worktree.

## Disposable PostgreSQL proof

On existing dedicated host alias `codex-dark-peak-5042`, preflight confirmed uid 0, no resources with the fresh packet names, and the protected `codex-universal` baseline. No new host, paid resource, provider, or production database was used. The only network was an internal Docker bridge with the two proof containers; database port publishing and host binds were empty. The test used the existing pinned PostgreSQL 17 Alpine image and existing Universal image under `runsc`.

Resources during proof:

- PostgreSQL container `orloom-pr1-pg-revalidation-20261013-db`, ID `5b979bc551e8a0d77e57f026f4ff0314ab2f4933932f3bd777d0469f1465bc0e`, image ID `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`, healthy, 0.5 CPU, 512 MiB, 64 PIDs.
- Test container `orloom-pr1-pg-revalidation-20261013-test`, ID `b0e47a9d69c2ec9520e87e6bd78d538b1399b56bdbf6076717e412805ff5edbf`, image ID `sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304`, `runsc`, uid/gid 65532, read-only root, cap-drop ALL, no-new-privileges, 1 CPU, 768 MiB, 128 PIDs.
- Internal network `orloom-pr1-pg-revalidation-20261013-net`, ID `5e77401cf9a4b072d5d0b5c20350118644b4f7012f6b8b3e88120841a8415653`; only DB and test were attached. DB private address was `172.19.0.2`.
- Dedicated volumes `orloom-pr1-pg-revalidation-20261013-data` and `orloom-pr1-pg-revalidation-20261013-secrets`; no host binds. Secret-file metadata only: database copy uid/gid 70, mode 0400, 64 bytes; test copy uid/gid 65532, mode 0400, 64 bytes. Secret bytes were not output or logged.

The run helper's exact-ID, digest-resolved image, labels, network attachments, volume consumers, mount policy, source identity, payload hashes, and protected-container preconditions passed before it reset the disposable database schema. The test exited 0 and printed:

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
protected_container_unchanged=true
```

The protected `codex-universal` stayed at ID `5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67`, StartedAt `2026-10-12T23:51:46.164222792Z`, restart count 0, running, runtime `runc`.

Cleanup script exit 0 removed the exact labeled containers, data/secret volumes, internal network, payload staging directory, and its empty parent. Post-cleanup inventory found no matching containers, volumes, network, or staging path; protected-container metadata remained unchanged. No actual workers, GitHub/provider calls, production migrations, or lane-capacity claims were involved.

## Concurrent worktree state change

After proof and cleanup, the shared path showed branch `feat/judgment-recovery`, HEAD `6110c692f47202978b2d22d22f6522aa4aa59277`, and untracked `.agent/ORL-005C1.md`, `docs/architecture/research/`, and `docs/evidence/`; these were not created by this packet and were left untouched. The controller subsequently reported that PR1 was merged and the new branch tree is identical to the validated `2d45b64` tree. This report reconciles the candidate state; the gate and PostgreSQL results remain bound to the recorded commit and payload hashes above.

Token use: UNKNOWN. No commit, push, merge, deployment, or provider call was performed.
