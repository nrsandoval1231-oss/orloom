# Candidate-admission foundation validation — 2026-10-14

## Source boundary

This successor adds an optional controller-owned candidate-admission bridge to merged repair PR #18 and worker PR #19. The last merged worker anchor is `d99b26ec828495b7648179a144bc4e38f5c5f80c`, reviewed tree `6f538b0690f673d49752fa90bb1b123762b97cfe`. The [167-test repair ledger](2026-10-14-consolidation.md) and [188-test worker ledger](2026-10-14-worker-composition.md) remain unchanged; their results do not certify this delta.

The [eight-file changed-source manifest](orloom-candidate-admission-changed-manifest.json), SHA-256 `99e76aaccd6058e19d61559236cd3f475a794e989f5b41925a593d4a2b21db86`, binds the bounded artifact reader, admission contracts, Governor/coordinator binding, candidate-specific runner, private Git admission, repository extraction seam and two regression test files. The apply-tested source patch SHA-256 is `33f62342071b9751311264813f64d24ba9e8cf6fbc47f145828c7527510ecc3b`.

The release [119-file source manifest](foundation-release/source-manifest.json), SHA-256 `c458c72a38a6e3811a3bc8739e8c253b3621ce0a69480c0a1bead476fe9694a3`, binds every included non-documentation runtime, build, test and configuration file by relative path, mode, size, SHA-256 and Git blob identity. It excludes generated output/dependencies, documentation and the unshipped local SQL diagnostic. This is a materialized exact-file snapshot, not an actual Git checkout commit. The current documentation overlay is assessed separately. Publication identity is supplied by the containing commit and associated PR; there is no circular self-commit claim.

## Independent source acceptance

[Boundary review](orloom-candidate-admission-independent-review.md): accepted as an inactive foundational bridge, with no remaining blocking finding in the reviewed source boundary. The reviewer checked all eight frozen hashes, reran 13 non-PGlite boundary tests and independently repeated the original same-SHA cached-commit substitution attack; the forged object identity was rejected. The PGlite coordinator regression was deliberately excluded from that focused review run to avoid overlapping the aggregate database suite. See [its log](orloom-candidate-admission-independent.log).

The builder's separate [focused run](orloom-candidate-admission-focused.log) passed 14/14 tests with zero failures/skips/cancellations. The coordinator test uses disposable PGlite and a controlled synthetic launcher/certificate; it does not produce a genuine runsc certificate or establish live PostgreSQL acceptance.

## Exact-source clean-install validation

Independent source-only release verification: **PASS**, recorded at 2026-10-14 04:53:30 UTC. [Machine-readable report](foundation-release/verification-report.json), SHA-256 `3f9f008ed9b27059d934cc9068dba6919a6156f71037eb2f214460401746c402`.

- Node `v24.19.0`, npm `11.9.0`; fresh locked `npm ci` with a private empty cache installed 99 packages successfully. [Install log](foundation-release/npm-ci.log).
- Typecheck, build and structure validation: exit 0. [Typecheck](foundation-release/typecheck.log), [build](foundation-release/build.log), [validation](foundation-release/validate.log), [gate chronology](foundation-release/gates.log).
- `npm exec --offline -c 'node --test --test-concurrency=1 dist/tests/*.test.js'`: **202/202 PASS**, zero failures/cancellations/skips, exit 0, 88881.444016 ms. [Full successful log](foundation-release/full-suite.log).
- All 119 non-documentation source inputs matched the frozen original before and after the successful suite. No production code changed during validation.
- The first materialized-snapshot run had 201/202 passes and zero skips; its sole failure was the existing `git ls-files` test prerequisite because the snapshot had no Git metadata. The validator created a local-only Git index, with no commit or remote, and reran the unchanged full suite successfully. [Original failed harness log](foundation-release/full-suite-without-git-metadata.log) is retained, not discarded or counted as acceptance.

Release-validator artifacts are retained byte-for-byte with their [hash list](foundation-release/artifact-sha256.txt); they contain no internal workspace paths. The copied independent boundary review only rewrites local evidence references to the retained relative artifact names. Historical ledgers are untouched.

## Implemented boundary and remaining gates

- Persisted final-candidate bindings govern artifact/index hashes, repository/base/candidate, mission/slice/epoch, approved plan/policy and scopes. Admission checks a single direct-child candidate, strict Git object integrity, bounded regular-file extraction and immutable private receipts.
- Candidate-specific facades retain source identity through preparation, execution, receipt submission and certificate readback without moving the trusted base ref. They share the existing verifier concurrency limit.
- Linux fixed Git/prlimit subprocesses enforce child resource limits, deadlines and output caps. Artifact reads are bounded, cancellable and hash-checked. Candidate code is never checked out or executed by admission.
- One controller process exclusively owns the private root: one active import, at most six waiting callers and at most 16 retained entries, including interrupted staging. There is no cross-process lock, automatic eviction or completed retention lifecycle. Operator retention review is required when full.
- Pre-dispatch transport/capacity/cancellation failures remain retryable without a permanent dispatch-failure row. Malformed candidates remain unavailable/UNKNOWN. Existing durable verifier UNKNOWN and quarantine semantics remain conservative.
- The bridge is dependency-injected only. Normal controller startup does not instantiate it, and normal worker startup still exits before secret reads, claims or provider calls. Recovery checkpoint admission is explicitly unsupported.

Operational admission wiring, broker recovery/checkpoint execution, owner cancellation, exact-container reconciliation and conservative interrupted-spend/quarantine release remain open. So do clean deployment-image acceptance, authentic exact-source runsc full-suite certification, live PostgreSQL acceptance, secure live provider/App/R2 configuration, a real goal-to-delivery mission and measured fresh-task learning gains. This source acceptance grants no new credentials, spending, activation or deployment authority.
