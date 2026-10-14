# Independent candidate-admission boundary review

Date: 2026-10-14 UTC

## Verdict

Accepted as an inactive, controller-owned foundational bridge. No remaining blocking finding in the reviewed source boundary. This is not acceptance to activate workers, deploy, invoke providers, create credentials, or claim an operational delivery mission. Full aggregate release validation is separately owned by the release validator.

Frozen changed-source manifest: [changed-source manifest](orloom-candidate-admission-changed-manifest.json), SHA-256 `99e76aaccd6058e19d61559236cd3f475a794e989f5b41925a593d4a2b21db86`. All eight listed source/test hashes were independently checked against the codefreeze. Baseline is the independently reviewed worker-v2 plus audit repairs; this review covers the candidate-admission delta.

## Verified repairs

1. Cache integrity: every cached admission is re-read under strict Git fsck, exact direct-parent, private-head, tree, and input-manifest checks. The original independent exploit, changing commit metadata under its old loose-object SHA filename while keeping the same tree, now rejects.
2. Artifact and execution bounds: content-addressed bundle/index bytes are capped and rehashed; transport cancellation covers stalled reads; Linux Git children receive per-command/whole-admission deadlines and CPU/address-space/file-size/output limits. Import does not checkout or execute candidate source. Network protocols, hooks, replacement objects, alternates, grafts and shallow boundaries are disallowed.
3. Controller identity: persisted final candidate bindings include repository/base/candidate, mission/slice/epoch, plan/lease policy, scopes and evidence references. Exact worker index binding and one direct child of approved base are required. Preparation, execution, submission and certificate lookup use candidate-local observations; the shared trusted repository head is not advanced.
4. Concurrency: per-candidate facades share one existing verifier and its independent concurrency limiter. Admission uses one process-wide active slot and six bounded waiters. Each caller owns its cancellation, including repeated same-binding callers.
5. Retention: a new admission cannot create staging when the private root already has 16 entries. Interrupted staging counts toward the cap; existing validated entries remain reusable. No automatic eviction or deletion of potentially relevant evidence is performed.
6. Retry semantics: admission queue saturation, cancellation/deadline, transport outage and retention-capacity refusal use transient errors; coordinator preparation does not write permanent dispatch-failure rows for these. Invalid candidate evidence remains unavailable/UNKNOWN. Existing verifier attempt UNKNOWN/quarantine behavior is not relaxed.
7. Durable authority: SQL attempt creation and receipt submission retain their persisted candidate/epoch/plan/policy checks. The admission bridge supplies source identity; it does not create independent authority to certify a builder's self-reported success. Candidate-specific facade request checks and fresh byte-for-byte input readback prevent retargeting.

## Fresh independent evidence

Executed after codefreeze:

`node --test --test-concurrency=1 --test-skip-pattern='persisted coordinator' dist/tests/candidate-admission.test.js dist/tests/candidate-artifact-reader.test.js`

Result: 13 tests passed; zero failures/cancellations. The PGlite coordinator test was deliberately excluded from this run to preserve the separate aggregate validator's exclusive database-suite run. This is not a claim that 13 tests are the full release suite.

Also reran the original independent same-SHA commit-metadata substitution probe against the frozen build: assertion passed, forged object identity rejected. Log: [independent boundary log](orloom-candidate-admission-independent.log). Reproducer used only temporary synthetic Git repositories, which were cleaned afterward; no remote service calls.

Builder's focused log additionally reports 14/14, including its disposable PGlite coordinator test. That test uses a controlled fake launcher returning success so the real store can exercise certificate lookup; the resulting certificate is synthetic test evidence only. It does not establish real runsc execution, genuine sandbox certification or production readiness.

## Remaining limits and activation prerequisites

- The importer requires Linux `/usr/bin/git` and `/usr/bin/prlimit`, an operator-owned private local directory, and exclusive ownership by one controller process. The semaphore and retention count are not a cross-process/distributed admission lock.
- The hard 16-entry retention limit intentionally stops new admissions until an operator reviews retention. It does not supply automatic archival, deletion, distributed storage quotas or retention lifecycle management.
- Cached readback intentionally reacquires and revalidates artifact transport and source state; a later outage hides certificate availability rather than accepting stale observations.
- Admission is bounded to the reviewed v2 bundle shape and a single direct-child candidate. Recovery checkpoint admission is refused. No browser/owner-supplied arbitrary source override is added.
- The production worker entrypoint remains fail-closed. Automatic recovery, durable cancellation/reconciliation, fully composed startup, live independent runtime proof and one real end-to-end mission remain distinct unfinished work.
- These tests use local synthetic fixtures. They do not exercise real R2 credentials/services, GitHub delivery, Docker/runsc, live providers, deployment or production PostgreSQL.

No production implementation edits were made by this independent reviewer.
