# C3: exact-commit syntax verification on the existing cloud host

Executed source: `765943eae18c09aa882e52c7f5255dd776c5fd43`. Source manifest SHA256: `91c672bd6519df3ef6344878cb75ddd81eb9285c9ad15f5528c85710ad89a211`. Source review passed; controller installation, typecheck, build, 66 tests, foundation validation and diff checks passed. This evidence addition does not certify a later documentation commit.

The real path was trusted bare Git extraction → credential-free runsc check → durable hashed local artifacts → private coordinator capability → PostgreSQL certificate. The finite check was `node --check scripts/validate.mjs`; certificate scope is **local-exact-commit**, not full CI, integration, deployment or GitHub freshness.

## Actual observations

- First certificate: `a634ca56-755e-492b-853a-5f283e80e31c`, candidate `765943e`, check elapsed 2,789 ms from receipt timestamps. This is one check measurement, not a performance improvement claim.
- A separate process held the host flock. A genuine competing coordinator attempt returned UNKNOWN without a new container or automatic redispatch. A separate check passed after release.
- The executed harness reached its later interruption stage only after wrong-capability rejection, artifact tamper rejection/read-back, concurrent identical submission, stale-local-head denial and PostgreSQL/runner/coordinator reconnect assertions. Six distinct PostgreSQL backend PIDs were retained. These assertions are reproducible test evidence, not additional live provider results.
- Interruption attempt `0ec63b75-0377-4c4b-82b5-7df55afbcf4e` remained UNKNOWN. A new process lost its volatile capability. The dedicated launcher was killed by the harness failure handler after its exact container ID was durably recorded. The observed container phase was **created**, not running. The original harness incorrectly accepted only running/exited and therefore failed; that failure is retained unchanged.
- A separate continuation used the real clock after the original reporting capability expired, retained UNKNOWN/no redispatch, and launched a distinct mission in the already provisioned auxiliary database. The trusted source launcher reconciled only the exact recorded old container before the new check. Certificate `84e7844f-5a3c-4ff2-9a54-efa2b80e7bc5` passed, and the old container/state were absent afterward.
- Actual inspected sandbox settings: runsc, network none, nonroot 65532, readonly root, all capabilities dropped, no-new-privileges, no host mounts, 0.5 CPU, 256 MiB memory, 64 PIDs, bounded tmpfs. This demonstrates one-check configuration, not six-builder or full-suite capacity.

## Retained evidence and failures

`retained-combined.tar.gz` contains original Linux evidence, candidate snapshot, six content-addressed artifact blobs and resource inspections. SHA256: `3545a1c6ce5c8e5550cfff92a494b5d0056001f2d95cf05947e9b4319b55acc7` (430,228 bytes). The readable `attempt1/` and `continuation/` extracts preserve original bytes. The controller verified all six artifact blob hashes, receipt/certificate bindings, input/log hashes and continuation manifest hashes.

`helpers/runtime-proof-attempt1.mjs` is the actual executed payload (SHA256 `70805d3f34163e5b6afe6740771a5445d2b1737906d9412fa64341425f34c2bf`), with the incorrect phase assertion at line 236 preserved. `helpers/continue-runtime-proof.mjs` is the executed continuation (`bf37dd990f286f334a817a4493d8c67ba8beba62cbc1141e1505200df3706b13`); its wrapper is `1b6f62c5c6a20caf004bde385975f34b64b110c66f8235ae57fb3ae2456b4d46`. The original run wrapper was restored to its exact recorded pre-run hash, `cddedda9a633c31263bf874e949569d031fae353c3f5a338c0a1eea41d489578`, after an unexecuted helper edit. Source code never changed during these proof repairs.

The earlier staging failure compared a requested image name to a numeric image ID. Its stopped temporary copy container was independently identified and removed by exact ID; the repaired staging attempt checked both identities and passed. Raw failed/successful outputs and the original failed helper are retained. A direct Windows SCP evidence download hit long-path limits; the complete archive above was subsequently retrieved and checked. Partial local extraction was not used as complete evidence.

## Cleanup and limits

The temporary database container, secret/data volumes, network and staging directory (including the generated database credential) were removed after evidence retention. Controller inspection independently found no C3 test containers, network, volumes, old input, stale Docker config or durable slot state. Protected `codex-universal` retained its exact ID/start time/restart count/runtime/running state. The warm verifier image, trusted source checkout and nonsecret evidence remain on the existing host. No new paid resources or provider calls occurred.

This is not full build/test/lint/typecheck/security CI, R2 retention, GitHub Checks publication, remote-head certification, a deployed service, independent engineering-outcome certification or learning improvement. C1b lesson promotion remains closed. PR #2 remains frozen. PR #4 remains draft and unmerged. Root orchestration durations and token usage are UNKNOWN where not directly measured; no speedup is claimed.
