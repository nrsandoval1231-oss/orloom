# ORL-C3 Memory Diagnosis — 2026-10-13

## Verdict

`663af2c3e97852c28e06433baf39ac811dccf0ba` remains **UNKNOWN**, with zero certificates. The serial-file repair was exercised: it did not avoid the OOM. Do not increase the sandbox memory, swap, PID, CPU, or deadline limits, and do not rerun either retained attempt.

The next action is one bounded, instrumented candidate and one fresh proof. It must identify the test-file boundary and cgroup memory composition that reaches the existing 1 GiB ceiling before choosing a code-level mitigation.

## Evidence

| Observation | Evidence | Meaning |
| --- | --- | --- |
| The repaired policy runs Node with `--test-concurrency=1`. | `infra/verifier-isolation/run-repo-suite.js` at `663af2c`; `packages/verification/src/policy.ts` | File concurrency was already one in the failed serial run, so lowering it again is not a repair. |
| The fresh receipt is `UNKNOWN`, null exit code, and names the fixed image `sha256:3211a00302fe74c02a9cb127a48bba290088841f6e6ba208c6ab4fdfadd31021`. | `work/serial-before-cleanup-extracted/artifacts/a8f68e...` | The result is tied to the repaired source/image, but is not acceptance. |
| Kernel event at `2026-10-13 12:20:42 UTC` is `CONSTRAINT_MEMCG` for Docker scope `docker-09c17d341299ccfaef6e0ef9345aaf4c7be9d1dbf1842442d7206e932e65e97d.scope`; it killed `gvisor_sentry`. | Scoped read-only `journalctl -k` on `codex-dark-peak-5042` | This is an exact sandbox cgroup OOM, not host-wide exhaustion, a deadline event, or the protected container. |
| That cgroup was exactly `1,048,576 KiB` used at the `1,048,576 KiB` limit, with 3,636 failed charges. Its accounted memory was about 986 MiB `shmem`/`file`, 25 MiB anonymous, and 13 MiB kernel. | Same kernel record | The dominant allocation is shared-memory-backed guest/runtime memory. It is inconsistent with a simple Node JS heap-only diagnosis. |
| The fault path is `shmem_alloc_and_add_folio`/`shmem_fault`, and multiple `gvisor_sentry` tasks carried shared RSS. | Same kernel record | gVisor's guest memory backing is the immediate charged allocator. The kernel cannot name the guest process, JavaScript module, or test file. |
| Advisory frames reached node-tests after admission (236 ms), typecheck (21,815 ms), build (28,843 ms), and discovery (5 ms), then stopped. | `work/suite-serial-executions/actual-sandbox-events.jsonl`; retained serial receipt | The failure is constrained to the node-test phase. |
| Only `tests/jobs.test.ts` and `tests/missions.test.ts` import PGlite. | source at `663af2c` | PGlite/WASM is a plausible source of the shmem pressure, especially in gVisor, but this is an inference rather than proof. |

The earlier OOM source `9ebc9d9` had no single-file limit; its retained record is useful historical evidence only. The serial attempt proves that file-level parallelism alone does not explain the failure.

## Proposed packet: ORL-C3-MEM-001

**Objective.** Produce allocation evidence for one fresh, exact source/image candidate while preserving the full 14-file suite and the current resource and time budgets.

**Allowed source files.**

- `infra/verifier-isolation/run-repo-suite.js`
- `infra/verifier-isolation/suite-diagnostics.js`
- focused tests for those two modules only

**Explicit exclusions.**

- No changes to application, PGlite tests, test assertions, package versions, Docker resource flags, PostgreSQL allocation, deadlines, or certificate semantics.
- No changes to PR #2, protected container `5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67`, providers, credentials, or `/var/lib/orloom/codex`.

**Smallest implementation.** Keep lexical discovery and run each discovered file in a separate, serial `node --test --test-concurrency=1 dist/tests/<file>` invocation. Emit bounded, fixed-schema advisory frames for each file's start and end (basename, ordinal, elapsed time, outcome; no paths outside `dist/tests`, no environment values, no payload). A failed/unknown file still stops the suite and preserves the current fail-closed result semantics. This changes no test selection and gives the host one unambiguous active-file boundary.

Add a packet-owned host helper that, after exact sandbox CID verification, polls only that container's cgroup `memory.current`, `memory.stat` (`anon`, `file`, `shmem`), and `memory.events` at a fixed 250 ms interval. It writes a bounded JSONL evidence file with UTC timestamp and no environment, process command, filesystem, database, or secret data. It must start before the node-test frame, stop on container exit, and bind rows to candidate SHA, image digest, sandbox CID, and run ID. The helper is observation-only; an unavailable cgroup sample is `UNKNOWN`, never a reason to relax the test.

**Acceptance criteria.**

1. Full existing discovery remains exactly 14 files and every existing file is executed in lexical order once.
2. Deterministic local gates and an independent source review pass for the new exact candidate.
3. One fresh runsc/PostgreSQL proof retains the test-file frame and cgroup sample artifact, or a clearly bound `UNKNOWN` telemetry failure. It retains the fixed 1 CPU/1 GiB/128 PID/no-network/read-only/no-mount profile and current finite deadline schedule.
4. Cleanup and protected-container identity proof remain required. No PASS is claimed unless the existing certificate, reconnect, stale-ref, and negative fixture gates complete.

**Decision after the packet.** If samples show growth during one PGlite file, the next repair may target that file's PGlite lifecycle/WASM configuration with a focused reproduction. If growth is already high before node tests or occurs across ordinary files, treat it as a gVisor/runtime accounting issue and choose another diagnostic; do not attribute it to PGlite. If the instrumented run passes, validate the unchanged full acceptance contract before promotion.

## Boundaries

This diagnosis made no source, Docker, database, provider, credential, or protected-container mutation. The scoped host read was kernel OOM lines only. The current source remains `663af2c3e97852c28e06433baf39ac811dccf0ba`.
