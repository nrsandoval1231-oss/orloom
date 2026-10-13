# Learning activation and inspectable subsequent outcomes

Parent: evidence-learning PR #6, exact snapshot `7a6165e3e9ce143e13aaab3b9e5b735c8eb35cdc`. This focused successor preserves that implementation's challenge, versioned promotion, application and contradiction withdrawal. It does not certify PR #5 or activate production learning.

## Changes

- Governor promotion now fails closed without a controller-owned activation dependency. Normal startup supplies none; owner and worker requests cannot enable it. `CertifiedLearningActivation` requires a current `node-repo-suite-v1` certificate matching a pinned runtime SHA, mission, slice, certificate ID and policy. The deployment controller must establish that pinned SHA is the executing build and independently establish authentic recovery/PG acceptance before wiring this dependency. A supplied SHA or source test alone is insufficient.
- Independent challenge derives cohort from persisted mission-slice scopes and repository from the observed mission, then compares both to candidate provenance. The former code copied the candidate's cohort into its own observations; a regression demonstrated an incorrectly accepted altered cohort before the correction.
- Authenticated `GET /api/lessons/:id/impact` reads committed applied decisions and the exact subsequent authorized attempt from the existing PostgreSQL ledger. It retains lesson/version/challenge bindings, selected strategy, default alternative, attempt/receipt/candidate identities, and pass/fail/UNKNOWN/pending counts. It keeps outcomes visible after withdrawal, including withdrawal between decision and check creation. No new ledger, migration or management subsystem is introduced.
- The controlled scenario now offers two eligible alternatives. With identical alternative order, the fixed-choice SDK transport chooses `strategy:other` before promotion and `strategy:recovery` after independent challenge/promotion. The committed decision binds the exact lesson. Subsequent PASS and UNKNOWN survive reconnect; a separate contradictory FAIL withdraws the version and remains inspectable.

`preferenceChangedOrder` compares the committed selected strategy with the snapshot's first approved alternative. It is evidence of preference ordering, not a claim about what a live Jev call would otherwise choose. `measuredImprovement` stays null: these observations do not establish a causal performance gain. UNKNOWN and pending observations are not dropped from denominators or recast as successes.

## Validation and review

See `controller-tests.log` for the final local full-suite execution and `independent-review.json` for the focused source review and repaired race. Local HTTP/PGlite and injected SDK/runner tests exercise production Governor, challenger and SQL behavior. They are controlled source evidence, not runsc execution, real PostgreSQL multi-connection acceptance, live-provider performance, or cloud certification.

Earlier local attempts exposed a missing impact endpoint, the accepted altered cohort and a SQL UUID/text parameter mismatch; each was corrected. A first full-suite attempt lacked downloaded verifier files. A later attempt failed admission because the temporary reconstructed Git snapshot accidentally tracked dependencies; the snapshot was corrected without changing the admission policy. Those failures did not produce certificates or authorize promotion.

## Acceptance still open

Authentic executable recovery/artifact evidence, real PostgreSQL races/restart, the final integrated exact-commit isolated full suite, executing-runtime identity wiring and live measured improvement remain open. PR #5's timeout/OOM attempts remain UNKNOWN with no certification claim. Production activation is absent. No live provider calls, spending, deployment, main merge or PR #2 changes were made. Frozen PR #2 remains `8bbcfffbf631e5ad2972e34b41284198afc566e2`.
