# Slice 1a validation — persist controller-owned runtime intent before container creation

Recorded 2026-10-14. Commits `a60dc29f81f560d3a795256dcf7ac82a73ee5a77` (implementation) and its documentation successor on branch `slice/01-runtime-identity-cancellation`, parent `df5d9db` (Slice 0), base `86a972300708f9bc05f557c5c09efd1c0f7e2ba6`.

## Why Slice 1 was split

Slice 1 as written has two independent deliverables:

1. Persist controller-owned runtime intent **before** container creation — immutable image, exact name, ownership labels, worker/lease identity, retained container ID.
2. Durable authenticated owner cancellation that **fences stale work** before requesting interruption.

An independent audit of the preserved successor snapshot (52 modified + 24 new files, local commit `5c59eb3`) established that deliverable 2 is coupled to controller-side schema, store, route and Governor changes (`mission_cancellations`, `worker_runtime_bindings`, the `cancel_requested`/`cancelling`/`cancelled` status vocabulary, `requestCancel`, a session-authenticated `POST /api/missions/:id/cancel`, lease-bound cancellation polling). Porting both at once would have mixed a bounded worker-runtime change with a schema and authorization change. Slice 1 is therefore split, and **only 1a is implemented here**. Slice 1b is not started; its scope is recorded below.

## What was reused, and its provenance

`apps/worker/src/runtime-journal.ts` and `tests/runtime-journal.test.ts` are adopted from the preserved successor snapshot at local commit `5c59eb3f87fd520651c811d243f02a1af3433853` (base `86a9723`). That commit exists only in a separate local working copy and was **never pushed**; it is retained as a verified complete-history Git bundle (5,117,327 bytes) outside the repository, and the snapshot was committed locally before any edit. Reuse was authorised only after verifying provenance (same base commit, contained in no merged PR) and fit (self-contained, Node builtins only, already regression-tested for quarantine, identity reuse, crash safety and stale-evidence rejection).

Three deliberate changes were made to adopted code, all from review findings:

- `ownershipLabelsDigest` sorted entries with `localeCompare`. Because this digest is *persisted* as the binding between a durable intent and the labels actually applied to a container, collation-dependent ordering could let hosts disagree. It now sorts byte-wise.
- The journal's `imageRefPattern` was case-sensitive while `docker-runtime.ts`'s equivalent is not, so a ref one layer accepted another rejected. Aligned with `/i`.
- `retain` ordering was added to `createContainerWithDurableIntent` (see the review section) — an authored change, not adopted.

## Implementation

- `ownershipLabels(name, leaseEpoch)` is now the single constructor of worker ownership labels. `DockerRpc.launch` and the durable intent both use it, so the persisted `labelsDigest` cannot diverge from the labels Docker receives.
- `controllerRunIdFor(lease)` derives the run identity by hashing controller-issued lease fields only (`protocol`, mission id, slice id, epoch, plan digest, trusted-check policy digest). It deliberately **excludes** lease expiry, because heartbeats renew it and including it would re-identify a live lease and could admit a second container at the same epoch.
- `createContainerWithDurableIntent` records the intent, invokes creation, hands the created container to the caller's `retain` callback, and only then attempts the durable binding. A binding failure therefore cannot orphan a container: ownership is taken before the binding write.
- `DockerWorkspace.checkout` uses that helper when a `runtimeJournal` is supplied, and is unchanged otherwise. `DockerRpc` exposes its retained `id`.
- `DockerWorkerRuntimeOptions.runtimeJournal` is dependency-injected. **Startup composition that requires it is not wired here** — see limitations.

## Checks and results

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | — |
| Build | `npm run build` | 0 | — |
| Validation | `npm run validate` | 0 | Foundation structure validation passed |
| Focused | `node --test dist/tests/runtime-journal.test.js` | 0 | 15 tests, 14 pass, 0 fail, **1 skipped** |
| Focused | `node --test dist/tests/runtime-intent-persistence.test.js` | 0 | 12 tests, 12 pass, 0 fail, 0 skipped |
| Full suite | `npm test` | 1 | **229 tests, 215 pass, 13 fail, 0 cancelled, 1 skipped, 66503.18 ms** |

Accepted run: 229 = 202 + 15 + 12 tests; 215 = 189 + 14 + 12 passes. The worktree was clean before and after, `package.json` and `package-lock.json` are unchanged, and commit/tree are unchanged by the check chain.

**The 13 failures are unchanged from the Slice 0 baseline** and are exactly the 13 tests of `tests/candidate-admission.test.ts`, refused by the documented Linux/POSIX guard (`candidate-admission.ts:73`, `:45`, `:49`). No new failure was introduced. The single skip is the journal test's `symlinked record` case, which needs Windows symlink privilege.

## Intermittent suite failures on this host (retained, not hidden)

Four full-suite runs were performed. Three additional tests failed intermittently, each in a different run, and each passes in isolation:

| Run | Tests | Pass | Fail | Failure set |
|---|---|---|---|---|
| 1 | 224 | 210 | 15 | 13 candidate-admission **+ `integration-replay-race` + `verification-runner`** |
| 2 (independent reviewer) | 226 | 212 | 13 | 13 candidate-admission only |
| 3 | 230 | 215 | 14 | 13 candidate-admission **+ `mission-http`** (file-level) |
| 4 (accepted) | 229 | 215 | 13 | 13 candidate-admission only |

Run 3's 230 includes one file-level failure record, so its real test count is 229. In isolation: `integration-replay-race` 1/1 pass (73.0 s), `verification-runner` 14/14 pass (8.2 s), `mission-http` 1/1 pass. None of the three references the changed modules, and `mission-http` binds `port: 0`, so port contention is not the explanation. `integration-replay-race` contains an explicit barrier deadline that reports `replay race barrier was not reached`.

**Conclusion:** the suite has pre-existing intermittent, load-sensitive flakiness on this Windows host, independent of Slice 1a. Every run is retained. This is a baseline property worth knowing: a single green-or-red number is not reproducible on this host, and only Linux acceptance (Slice 6) can settle it.

## Independent adversarial review

An independent reviewer with no builder context reviewed the diff and reproduced the checks on this host (its own run: 226 tests / 212 pass / 13 fail / 1 skip; worker subset 19/19). Verdict: *accept only as source+fixture evidence for an inert, unwired capability*. Disposition of every finding:

| Finding | Disposition |
|---|---|
| **D1** orphan container + leaked `DockerRpc` when the binding fails after a successful create — a cleanup **regression** introduced by this change, because the previous code set `this.rpc` the instant launch resolved | **FIXED.** `retain` is invoked before the binding write, and `DockerWorkspace` takes ownership there. Regression test added: `the live container is placed under the caller's control before the durable binding is attempted`. |
| **D2** a discovered container ID cannot be bound to an `intent` entry; from `intent` only `absent`/`unknown` with `containerId: null` is accepted, so a reconciler that finds an orphan cannot record its exact ID | **Confirmed, recorded, not fixed.** Recorded as a limitation. Binding a discovered ID is Slice 2 reconciliation work. |
| **D3** a crash between `writeTemp` and `unlink` leaves a `.tmp`, which quarantines the whole journal until an operator intervenes; the restart test covers only a clean restart | **Confirmed, recorded.** Documented as a limitation with an operator requirement. |
| **D4** image-ref case-sensitivity divergence | **FIXED** (`/i`). |
| **D5** other persisted digests still sort with `localeCompare` (`verification/src/repository.ts:69`, `learning/src/challenger.ts:83`/`:58`/`:62`, `contracts/src/sql-mission-store.ts:312`, `runtime-journal.ts` `unresolved()` ordering) | **Confirmed, out of scope, recorded** as a follow-up class of bug for a later slice. |
| **U1** the mechanism is inert: `broker-main.ts:57` constructs the runtime without a journal, so production takes the `else` path | **Confirmed and disclosed.** Recorded as limitation 1 and in the active docs; activation is Slice 5. |
| **U2** the digest regression test could not distinguish `localeCompare` from byte order for the closed 3-label set, so it passed against the unfixed code | **FIXED.** A discriminating test with labels whose byte and collated orders differ (`{"a","B"}`) now asserts the byte-ordered digest and that the collated digest differs. |
| **U3** the "binds the exact ownership labels" test injects `create`, never observes Docker's applied labels, and its digest assertion is partly tautological | **Partially addressed.** The single-source `ownershipLabels` guarantee is now stated as code-reading + fixture evidence rather than an observed Docker property; the tautological expectations are no longer the only assertion. Full observation needs Docker (Slice 6). |
| **U4** `controllerRunIdFor` included lease expiry, so a same-epoch lease reissued with a new expiry — or heartbeat renewal — changed the identity, permitting two containers at one epoch | **FIXED.** Expiry removed from the derivation; regression test asserts renewal does not change the identity. |
| **U5** `RUNTIME_RECONCILER_SOURCE` is a constant, not authentication; journal-root access permits self-asserted absence | **Confirmed, recorded.** 1a releases no capacity, so the slice rule is not violated; noted as a latent hole for 1b/2. |

The reviewer could not verify, on this host: real Docker/runsc create/start and cleanup, the D1 leak end-to-end, fsync semantics, the operational-Linux uid/mode path (`syncDirectory` is skipped on win32), and the provenance commit `5c59eb3` (absent from the public repository by design — it is retained only as the external bundle named above).

## Gate coverage

| Slice 1 gate item | Status in 1a |
|---|---|
| Partial container creation | Covered. Create failure leaves the durable intent unresolved with `containerId: null` and no `created` transition; a binding failure leaves a reclaimable container; both are tested. |
| Restart | Covered for clean restart: the exact container ID survives, and re-running the same controller identity is refused rather than creating a second container. **Crash-left temporary files (D3) are not covered.** |
| Cancellation races | **Not covered — Slice 1b.** |
| Stale epochs | **Not covered — Slice 1b.** The journal rejects stale reconciliation observations, but no lease-epoch fence exists yet. |
| Duplicate cancellation | **Not covered — Slice 1b.** |
| No worker-supplied assertion can release capacity | Not applicable in 1a — no capacity-release path is introduced. Latent hole U5 recorded for 1b/2. |

## Evidence class

**Source and fixture only.** Exercised: worker-local filesystem durability, intent/create/bind ordering through an in-process seam, and portable journal semantics. **Not exercised:** Docker, runsc, Linux ownership/mode enforcement (`openOperational` is Linux-only and was never run), actual PostgreSQL, live provider, cancellation, or publication. The ordering test proves before-ness at the `createContainerWithDurableIntent` seam; it is not a Docker or runsc proof.

## Limitations and unresolved risks

1. **Not wired into startup.** `runtimeJournal` is optional; `broker-main.ts` does not supply it and `apps/worker/src/main.ts` still refuses to start. Requiring it belongs to the activation/composition gate (Slice 5), not here.
2. **D2:** an `intent`-state entry cannot accept a discovered container ID. A reconciler that finds an orphan can currently record only `absent` (with a null ID) or `unknown`, so the exact ID is retained only when the process survives to the binding write.
3. **D3:** a crash between `writeTemp` and `unlink` leaves a temporary file that quarantines the journal until an operator removes it. Restart coverage assumes a clean restart.
4. **U5:** the reconciler source is an unauthenticated constant; anything with journal-root access could self-assert absence. No capacity is released in 1a.
5. **`controllerRunId` is derived, not issued.** The successor instead persists a controller-issued `runtimeRunId` at claim time.
6. **No cross-process lock.** `runtime-journal.ts` serialises within one process only; the verifier slot uses a host-wide `flock`. Must be decided before multi-process deployment.
7. **Docker/Linux behaviour unverified from this host** — no Docker, WSL or Linux runner is available.
8. **U3:** the no-divergence guarantee between persisted `labelsDigest` and Docker's applied labels rests on single-source construction and code reading, not an observed Docker run.
9. **D5:** other persisted digests still sort with `localeCompare`; the class is not eliminated.
10. **Suite flakiness on this host** (above) means a single suite number is not reproducible here.

## Slice 1b scope (not started, recorded from the independent audit)

Durable authenticated owner cancellation that fences stale work: a Slice-1-only `009_worker_runtime.sql` (idempotent, because `postgres-store.ts` re-executes every migration at startup); `mission_cancellations` and `worker_runtime_bindings`; `SliceStatus` gains `cancel_requested`/`cancelled` with the lease-proof-retaining check constraint; `MissionStore.requestCancel`/`cancellationStatus`; a session-authenticated `POST /api/missions/:id/cancel` routed through the Governor rather than the store directly (the successor bypassed Governor-only authorization and must not be copied); lease-bound cancellation polling with one pre-flight poll before the first provider call; and an interleaved claim/cancel race regression, which the successor lacked.

Two successor defects must be fixed rather than ported: (a) `registerRuntime` persisted a worker-chosen container ID with no controller verification, letting a worker pair a fabricated ID with an exact name and later obtain a controller-observed "absent" — bounded, but it defeats the `complete()` cleanup fence; (b) `complete()` only fenced when a binding row existed, so a `runtime_required` claim with no row could complete. Additionally, `acknowledgeCancellation` had no explicit current-epoch comparison, and its client route (`cancellation-ack`) does not exist in the server's route table, so it 404s against the real server while a stubbed-fetch test hides that.
