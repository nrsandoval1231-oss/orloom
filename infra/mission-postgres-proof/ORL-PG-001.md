# ORL-PG-001 — PostgreSQL-backed mission-store proof

Scope: `work/mission-postgres-proof` artifacts and disposable test-only resources on `codex-dark-peak-5042`. No Orloom source edits, production database/deployment changes, provider keys/calls, paid resources, host credential mounts, or product worker execution.

Approved remote scope: private internal-only network `orloom-pg-proof-20261013-net`; temporary containers `orloom-pg-proof-20261013-db` and `orloom-pg-proof-20261013-test`; test-only data volume and owner-restricted local secret volume. No published ports or host bind mounts. Official PostgreSQL image is pinned to immutable digest. PostgreSQL is limited to 0.5 CPU/512 MiB/64 PIDs; test container to 1 CPU/768 MiB/128 PIDs. Test container uses the existing pinned Codex Universal image under opt-in runsc, nonroot, read-only rootfs, cap-drop ALL, no-new-privileges, private work/tmpfs, internal validation network only.

The password is generated only inside a temporary Docker-managed local secret volume; it is never placed in args, env values, Docker config, logs, or output. PostgreSQL reads its `_FILE` path. The trusted test process reads its own mode-0400 copy into memory. Clean only the named test containers/network/volumes after evidence capture.

Proof cases: real concurrent PostgreSQL sessions; up to six distinct claims/slots and no seventh grant; one-slice race produces one claim; overlapping scopes serialize; SQL failure rolls back plan/slices/events; lease expiry transitions to UNKNOWN and retains reservation while quarantining the slot and scope; event history survives pool close/reconnect and migration rerun.

Final source proof was run against controller-confirmed manifest `c418a11e1e616eda7d1005c45a317082013d2c9923883f9dd58ed92bf414b287`; see `EVIDENCE.md` for source/bundle identity and both successful proof results.

Resource lifetime: the three labeled resources and exact names stayed up through the controller's independent proof rerun, then were removed with `cleanup-disposable.sh`. The script checked packet labels and the exact two network attachments before removal and verified the named containers, volumes, and network were gone. The protected `codex-universal` container was never a cleanup target.
