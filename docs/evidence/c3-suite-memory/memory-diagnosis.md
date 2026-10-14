# C3 jobs/PGlite memory diagnosis

Scope: read-only analysis of actual candidate 4d1dd56b4d16990a6b3222a40bd53ed5ddef3e5a. No source, host, runtime, or provider action was performed. The suite result remains UNKNOWN, with zero certificates.

## What the evidence proves

The exact verifier container was 6cd7a78b24ad3db0f316f5464280be857abed0451003a081943db396d4175506 for sandbox orloom-verifier-da669f5d-21ea-4ed1-ab4a-763bcf626841. Its cgroup stream is bound to that CID and image in work/memory-before-cleanup-extracted/evidence/runtime-39d2535a-bb35-49b9-bb6e-5f8de7ee7446/suite-ef657391-6d96-4b69-8e47-cca1876ea87a/passing/cgroup-memory-observations.jsonl.

* Dependency admission, typecheck, clean build, discovery, and test ordinals 1--5 passed. Ordinal 6, jobs.test.js, started and has no end frame.
* The same CID received Docker oom, then die with exit 137 and destroy. At the final sample (66,032 ms), cgroup current memory was 1,048,633,344 bytes; 1,035,644,928 bytes were shmem; oom_kill was 1. This is a cgroup OOM, not a test assertion failure or test-file concurrency failure.
* The trace has two distinct shared-memory episodes during the jobs file: it reaches 575,082,496 bytes current / 526,991,360 bytes shmem at 52,902 ms, then drops to 82,169,856 / 46,526,464 at 53,817 ms. It later rises from 113,115,136 / 68,714,496 at 58,712 ms to the cgroup limit at 66,032 ms. The material release between episodes rules out retained simultaneous allocation as the direct explanation.
* tests/jobs.test.ts constructs two sequential in-memory PGlite instances, each migrates the same database and calls close() only at the happy-path tail. The first episode/release and second terminal growth correlate with those two constructions, but the runner has file-level rather than subtest frames, so the artifact cannot assign either episode to an exact source line.

The installed, lock-pinned @electric-sql/pglite@0.5.9 source confirms that PGliteOptions accepts initialMemory; its constructor creates a WebAssembly.Memory with a default initial 2,048 pages (128 MiB) and a fixed maximum of 32,768 pages (2 GiB). initialMemory changes only the initial allocation: it is not a hard cap and cannot by itself prevent the observed growth to the 1 GiB verifier limit.

## Diagnosis

Proven: an exact, serial verifier cgroup was killed at its 1 GiB limit during jobs.test.js, with the excess overwhelmingly accounted as shmem.

Strong but not fully line-proven: the two in-memory PGlite/WASM lifecycles are the relevant allocator. The released first episode followed by a separate second growth makes an overlap leak unlikely; the second lifecycle or its workload is the immediate suspect. No artifact identifies whether the growth comes from PGlite initialization, migration, or the invalid-insert query.

## Smallest bounded repair and validation

Change only tests/jobs.test.ts in a fresh candidate:

1. Create one PGlite for a parent Node test, apply the migration once, and retain the two existing behaviours as serial named subtests against that instance. The second assertion (rejecting a made-up status) is independent of the rows left by the first behavior.
2. Put await db.close() in the parent's finally, so close runs on an assertion or setup failure. This is lifecycle correctness; it is not the claimed cause of the recorded OOM.
3. Do not change the verifier resource profile or test concurrency for the first discriminating run.

This removes the second full WASM/PGlite initialization that is correlated with the terminal episode while preserving the tested SQL-store and migration behaviours. It is narrower and better supported than replacing PGlite, skipping SQL tests, or an unmeasured resource increase.

Validate the changed exact candidate in this order:

1. Typecheck/build and run only the compiled jobs.test.js in the existing 1 GiB / serial verifier profile, retaining the exact-CID cgroup stream. Require exit 0, both named behaviours pass, and final cgroup events max=0, oom=0, and oom_kill=0.
2. If that passes, run the full suite once on the same unchanged profile and retain its exact-candidate frames, cgroup stream, Docker events, cleanup, and certificate decision.
3. If focused jobs.test.js still reaches max or OOMs, stop before the full suite. That falsifies the single-lifecycle repair as sufficient. The next discriminating run is a PGlite-only construct/migrate/close fixture under the same profile with stage markers.

A finite higher suite-only profile is eligible for a later, digest-bound, independently reviewed repair: the retained 13:01 UTC capacity observation reported 3,466,539,008 available host bytes on the existing 4 GiB host. It is not the recommended first move because the measured peak was truncated by the 1 GiB kill and the bundled PGlite WASM maximum is 2 GiB; a 2 GiB cgroup need not provide headroom over the engine plus Node runtime. Select a finite value only after the focused fixture measures a completed peak, then validate the full suite once under that exact profile. No new resource or unchanged blind full-suite rerun is warranted.

No source or profile change is justified from a hypothetical lower initialMemory setting: the bundled version has no caller-exposed maximum memory setting, and a lower starting allocation would not bound the measured growth.
