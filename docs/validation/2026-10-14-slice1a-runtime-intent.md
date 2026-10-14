# Slice 1a validation — persist controller-owned runtime intent before container creation

Recorded 2026-10-14. Commit `a60dc29f81f560d3a795256dcf7ac82a73ee5a77`, parent `df5d9db` (Slice 0), base `86a972300708f9bc05f557c5c09efd1c0f7e2ba6`.

## Why Slice 1 was split

Slice 1 as written has two independent deliverables:

1. Persist controller-owned runtime intent **before** container creation — immutable image, exact name, ownership labels, worker/lease identity, retained container ID.
2. Durable authenticated owner cancellation that **fences stale work** before requesting interruption.

An independent audit of the preserved successor snapshot (52 modified + 24 new files, local commit `5c59eb3`) established that deliverable 2 is coupled to controller-side schema, store, route and Governor changes (`mission_cancellations`, `worker_runtime_bindings`, `cancel_requested`/`cancelling`/`cancelled` status vocabulary, `requestCancel`, a session-authenticated `POST /api/missions/:id/cancel`, lease-bound worker cancellation polling). Porting both at once would have mixed a bounded worker-runtime change with a schema and authorization change. Slice 1 is therefore split, and **only 1a is implemented here**. Slice 1b is not started and its scope is recorded below.

## What was reused, and its provenance

`apps/worker/src/runtime-journal.ts` and `tests/runtime-journal.test.ts` are adopted from the preserved successor snapshot at local commit `5c59eb3f87fd520651c811d243f02a1af3433853` (base `86a9723`), retained outside the repository as a verified complete-history Git bundle. Reuse was authorised only after verifying provenance (same base commit, no merged PR contains this work) and fit (self-contained module, Node builtins only, already regression-tested for quarantine, identity reuse, crash safety and stale-evidence rejection).

**One deliberate change was made to the adopted code.** `ownershipLabelsDigest` sorted label entries with `localeCompare`. Because this digest is *persisted* as the binding between a durable intent and the labels actually applied to a container, collation-dependent ordering would let two hosts disagree on the same binding. It now sorts byte-wise. This was an independent-review finding from the audit, and a regression covers it.

## Implementation

- `ownershipLabels(name, leaseEpoch)` is now the single constructor of worker ownership labels. `DockerRpc.launch` and the durable intent both use it, so the persisted `labelsDigest` cannot diverge from the labels Docker actually receives.
- `controllerRunIdFor(lease)` derives the run identity by hashing controller-issued lease fields only (`protocol`, mission id, slice id, epoch, plan digest, trusted-check policy digest, lease expiry). The worker never asserts a run identity of its own.
- `createContainerWithDurableIntent({journal, identity, name, imageRef, labels, create})` records the intent, invokes creation, then retains the returned container ID bound to that intent.
- `DockerWorkspace.checkout` uses that helper when a `runtimeJournal` is supplied, and is unchanged otherwise. `DockerRpc` exposes its retained `id`.
- `DockerWorkerRuntimeOptions.runtimeJournal` is dependency-injected. **Startup composition that requires it is not wired here** — see limitations.

## Checks and results

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | — |
| Build | `npm run build` | 0 | — |
| Validation | `npm run validate` | 0 | Foundation structure validation passed |
| Focused | `node --test dist/tests/runtime-journal.test.js` | 0 | 15 tests, 14 pass, 0 fail, **1 skipped** |
| Focused | `node --test dist/tests/runtime-intent-persistence.test.ts` | 0 | 7 tests, 7 pass, 0 fail, 0 skipped |
| Full suite | `npm test` | 1 | **224 tests, 210 pass, 13 fail, 0 cancelled, 1 skipped, 70985.54 ms** |

The worktree was clean before and after, `package.json` and `package-lock.json` are unchanged, and commit/tree are unchanged by the check chain.

**The 13 failures are unchanged from the Slice 0 baseline** and are exactly the 13 tests of `tests/candidate-admission.test.ts`, refused by the documented Linux/POSIX guard (`candidate-admission.ts:73`, `:45`, `:49`). No new failure was introduced: 224 = 202 + 15 + 7 tests, 210 = 189 + 14 + 7 passes. The single skip is the journal test's `symlinked record` case, which cannot run without Windows symlink privilege.

Successful full-suite log excerpt is retained; the log is 81,716 bytes under [`slice1a-runtime-intent/`](slice1a-runtime-intent/).

## Gate coverage

| Slice 1 gate item | Status in 1a |
|---|---|
| Partial container creation | Covered. Create failure leaves the durable intent unresolved with `containerId: null` and no `created` transition. |
| Restart | Covered. A restarted journal retains the exact container ID, and re-running the same controller identity is refused rather than creating a second container. |
| Cancellation races | **Not covered — Slice 1b.** |
| Stale epochs | **Not covered — Slice 1b.** (The adopted journal does reject stale reconciliation observations, but no lease-epoch fence exists yet.) |
| Duplicate cancellation | **Not covered — Slice 1b.** |
| No worker-supplied assertion can release capacity | Not applicable in 1a: 1a introduces no capacity release path. The one successor hole identified for 1b is recorded below. |

## Evidence class

**Source and fixture only.** Exercised: worker-local filesystem durability, intent/create ordering via an in-process `create` seam, and portable journal semantics. **Not exercised:** Docker, runsc, Linux ownership/mode enforcement (`openOperational` is Linux-only and was never run), actual PostgreSQL, live provider, cancellation, or publication. The ordering test proves *before*-ness at the `createContainerWithDurableIntent` seam; it is not a Docker or runsc proof.

## Limitations and unresolved risks

1. **Not wired into startup.** `runtimeJournal` is optional in `DockerWorkerRuntimeOptions`; `broker-main.ts` does not supply it and `apps/worker/src/main.ts` still refuses to start. Requiring it, and refusing startup without it, belongs to the activation/composition gate (Slice 5), not here.
2. **`controllerRunId` is derived, not issued.** It is a digest of controller-issued lease fields. The successor instead persists a controller-issued `runtimeRunId` at claim time. Until 1b/1c adds that column, the derived identity is stable per lease but is not an independently issued controller identifier.
3. **No cross-process lock.** `runtime-journal.ts` serialises within one process only; the verifier slot instead uses a host-wide `flock`. This must be decided before multi-process deployment.
4. **Docker/Linux behaviour unverified from this host.** No Docker, WSL or Linux runner is available; `DockerWorkspace.checkout` cannot execute here.
5. **The create-to-`recordCreated` window** leaves a durable `intent` with no container ID if the process dies after `docker create` returns. That is deliberate and conservative, but nothing yet reconciles it — that is Slice 2.
6. **A leaked in-process RPC.** If `recordCreated` throws after a container was created, the durable intent is retained but the in-memory `DockerRpc` is not disposed. The container remains reconcilable by intent; the process-local leak is bounded and is superseded by Slice 2's reconciliation.

## Slice 1b scope (not started, recorded from the independent audit)

Durable authenticated owner cancellation that fences stale work, comprising: a Slice-1-only `009_worker_runtime.sql` (idempotent, since `postgres-store.ts` re-executes every migration at startup); `mission_cancellations` and `worker_runtime_bindings`; `SliceStatus` gains `cancel_requested`/`cancelled` with the lease-proof-retaining check constraint; `MissionStore.requestCancel`/`cancellationStatus`; a session-authenticated `POST /api/missions/:id/cancel` routed through the Governor rather than the store directly (the successor bypassed Governor-only authorization and must not be copied); lease-bound cancellation polling with one pre-flight poll before the first provider call; and an interleaved claim/cancel race regression, which the successor lacked.

Two successor defects must be fixed rather than ported: (a) `registerRuntime` persisted a worker-chosen container ID with no controller verification, letting a worker pair a fabricated ID with an exact name and later obtain a controller-observed "absent" — bounded, but it defeats the `complete()` cleanup fence; (b) `complete()` only fenced when a binding row existed, so a `runtime_required` claim with no row could complete.
