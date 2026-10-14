# ORL-005C1 repair 2 focused test attempts

This file preserves test failures from the repair-2 regression work. It is not source or runtime proof evidence.

## Attempt 1 — failing HTTP regressions

- Candidate checkout at run start: repair-2 working tree based on `bb925e904d32dbc871f72de028e60d504c0a4773`; no repair-2 freeze identity was claimed.
- Command: `npm test -- --test-name-pattern="candidate extraction excludes UNKNOWN pass evidence|mixed scope cohorts do not combine"`
- Result: exit 1; build succeeded; 46 tests passed and 4 recovery-learning tests failed.
- Failures: four progress requests returned HTTP 500 instead of 200. Root and mission_builder traced this to the repair-2 candidate SQL query leaving parameter `$4` unused while referring to `$5` and `$6`; mission_builder removed the unused argument and renumbered the digest parameters.
- Additional setup failure: config rejected `scopeClasses: ["*"]`; tests now use explicit `src` and `docs` classes.

## Attempt 2 — fixture order assertion

- Command: `node --test --test-name-pattern="authenticated HTTP and PGlite|episodes with different target checks|candidate extraction excludes UNKNOWN|mixed scope cohorts" dist/tests/recovery-learning.test.js`
- Result after rebuilding the SQL fix: exit 1; three selected regressions passed. The UNKNOWN-pass ordering test assumed plan insertion order, but claim order was lexical and returned `unknown-second` before `valid-first`.
- Repair: assign ordered fixture slice IDs with numeric prefixes (`episode-0-*`, `episode-1-*`) and bind the injected invalid judgment to the prefixed UNKNOWN slice.

## Successful focused validation

- `npm run build` — exit 0.
- `node --test --test-name-pattern="authenticated HTTP and PGlite|episodes with different target checks|candidate extraction excludes UNKNOWN|mixed scope cohorts" dist/tests/recovery-learning.test.js` — exit 0, 4/4 selected tests passed.
- `node --test dist/tests/recovery-learning.test.js` — exit 0, 8/8 tests passed, including lease expiry, budget-context mutation during a held decision, invalid continue, and blocked/unknown quarantine.
- `git diff --check -- tests/recovery-learning.test.ts` — exit 0.

These results are focused development checks only. The parent controller owns final gates, repair-2 source freeze, independent review, and release of the real-PostgreSQL runtime proof.
