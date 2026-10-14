# Orloom consolidated repairs: independent review

Date: 2026-10-14, 04:21 UTC.

## Verdict

PASS for the reviewed bounded control-plane repair candidate. No new material blocker or regression found in the reviewed changes. This is not approval for production deployment or a claim of a complete live autonomous engineering product.

## Frozen source identity

Reviewed source was materialized from exact PR #17 `410882d4afff33e028be50b816ad69eb387eae6d`; the manifest below is the authoritative binding for the repaired files. The containing Git commit and associated PR identify publication, without implying merge.

89 tracked runtime, test, script, migration, package/config and Docker-ignore files are individually SHA-256 bound in [the reviewed source manifest](2026-10-14-consolidation-source-manifest.json). Its compact canonical JSON SHA-256 is `63345151c8d403d54b4f62836fdc658b9655ad16fbb60925b88c633671f4c285`. Every reviewed file was rechecked unchanged after the test run. Documentation/history additions and separate worker-broker integration are outside this source approval; published content must preserve these file bindings for this result to apply.

## Independent execution

Node v24.19.0 on Linux, existing locked dependencies. Independently executed in sequence:

- `npm run typecheck`: PASS.
- `npm run validate`: PASS.
- `npm test` (including production TypeScript build and asset helper): PASS, 167 tests, 0 failures, 0 skips, 0 cancellations, 45061 ms test duration.

Full captured test/build output: [orloom-consolidated-independent-tests.log](orloom-consolidated-independent-tests.log).

## Reviewed repairs

- HTTP claim uses the authoritative store `grant.planDigest`, eliminating its incompatible JSON digest. SQL and memory regressions verify equality with the lease binding and successful unchanged progress submission.
- Store claim and scheduling snapshot require the current allowlist; whole approved plans containing removed checks are excluded before any lease/budget binding. Governor consistently supplies the same allowlist used in plan recommendation. Typechecked call sites were migrated; missing untyped allowlists fail closed.
- Claim invokes each store's existing aggregate reducer, retaining UNKNOWN/BLOCKED precedence and quarantine. SQL grant reads the updated mission budget/status.
- Control-plane Docker build stage now copies scripts needed by its build helper. The new test stages declared COPY inputs, runs the helper, and checks copied bytes/executable mode. This is not an actual Docker build.
- Loom integration-intent digests are matched to the exact certificate ID, with missing, malformed, contradictory and permuted-pair regressions.
- Learning candidate generation, challenge readback, accepted-challenge persistence, and promotion evaluate retained trusted-negative/withdrawal cutoffs. Four distinct committed evidence records and their trusted attempt creation times must follow the cutoff. Stale candidates remain retained but cannot block genuinely fresh replacements.
- Tests exercise withdrawal followed by an unrelated pass, old-baseline/new-pass exclusion, two wholly fresh episodes and successful version-2 repromotion, restart/readback continuity, negative evidence before initial promotion, and stale accepted challenge rejection.
- Both Governor cohort calculations use shared normalization, covering mixed case and whitespace. Measured improvement remains null.

## Acceptance boundaries

Docker, PostgreSQL server, and runsc executables are absent here. SQL lifecycle coverage used embedded PGlite; runner/provider/publication paths use controlled fixtures. The green Linux source suite resolves the local full-suite acceptance question for this frozen candidate, but does not establish a clean deployment image, live PostgreSQL/runsc proof, live Jev/DeepSeek behavior, credentialed publication, productive six-lane capacity, or causal learning improvement.

The executable worker, production advice/learning activation, operational quarantine reconciliation, full canonical Loom/UI, and fresh baseline-versus-strategy evaluation remain separate work. Keep production activation closed until its dedicated evidence and prerequisites are satisfied.

## Source-merge eligibility assessment

A bounded owner-authorized source merge is supportable; no explicit requirement in the original PR17 finish contract or canonical harness makes Docker/runsc/live-PostgreSQL/live-provider completion a universal prerequisite for source merge. Canonical harness line 3 describes a target-system ADR; line 32 explicitly separates source implementation, deterministic behavior, live execution, deployment and certified outcomes. Original finish-contract lines 26–28 retain authentic C1b/C3 acceptance requirements and explicitly distinguish repository merge from certified outcomes.

This conclusion is conditional on exact published source preservation, reviewed reconciled documentation, sufficient owner merge authority and applicable actual branch policy. An absence of GitHub checks is neither a passing check nor a blocker by itself. Production activation stays closed, and all authentic operational/isolated-certification gates remain OPEN.

The Forge CI contract separately requires trusted external-policy, disposable isolated validation and a fresh locked installation. The initial local source regression run used existing dependencies and is not Forge certification or C3 acceptance. A clean disposable-install follow-up completed successfully as reported below; even a successful clean local run cannot establish authentic runsc/cloud acceptance.

## Clean locked-install follow-up and documentation review

Completed 2026-10-14 04:27 UTC in a separate disposable workspace copy, with its own node_modules and npm cache. Parent frozen source and dependencies were not changed.

- `npm ci --cache <copy>/.npm-cache`: PASS, 99 packages installed from committed lockfile; no package/lock source changes.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run validate`: PASS.
- `npm test`: PASS, 167/167, zero failures, skips or cancellations; 44117 ms test duration.
- All 89 manifest-bound source/config/test files matched the initial reviewed manifest in the clean copy.

Retained final logs: [orloom-clean-install-final.log](orloom-clean-install-final.log), [orloom-clean-validation-final.log](orloom-clean-validation-final.log), [orloom-clean-tests-final.log](orloom-clean-tests-final.log).

The first installation attempt needed a writable local npm cache because the default user npm cache directory was missing (ENOENT). A first clean suite attempt under `/tmp` reported 139 passes and four failures: two verifier configuration cases derive persistent-artifact paths from the checkout parent and correctly hit the production temporary-directory rejection; two PGlite-heavy test files terminated with only “test failed,” without a diagnostic cause. Concurrent PGlite-heavy suites may have contributed, but that is not proven. The failed output is retained as [orloom-clean-tests-initial-tmp.log](orloom-clean-tests-initial-tmp.log). Moving the disposable checkout outside `/tmp`, repeating locked installation, and rerunning all gates produced the complete green result above without any source changes. No access-denial bypass or new credentials/services were used.

The finalized reconciled README, finish contract, validation ledger and current-state/work-graph documents were reviewed for honest source-versus-operational boundaries. One stale line listing combined source acceptance as OPEN was corrected to publication-tree identity/readback verification. No further blocking documentation contradiction found in that reviewed set. Historical evidence preservation still requires exact published-tree readback.

The clean-install result strengthens reproducible source acceptance. It is still not external Forge-policy certification, an authentic runsc run, live PostgreSQL acceptance, deployment, live providers, or demonstrated learning gains; those gates remain OPEN.

Publication copies of failed-run stack traces replace incidental absolute checkout prefixes with `[temporary-checkout]`; failure messages, line numbers, results and test counts are otherwise retained.
