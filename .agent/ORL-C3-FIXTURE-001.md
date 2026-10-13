# ORL-C3-FIXTURE-001 — writable scratch copy for immutable suite input

**Objective:** Repair the local test fixture that models a read-only extracted repository while still exercising stale dependency-lock rejection.

**Identity and scope:** Worktree `work/orloom-fixture-repair`, branch `fix/nonroot-suite-fixture`, exact base `8f271de796e643a3a0b9b47b80fc1de3e3646d9d`. Allowed: `tests/verification-runner.test.ts`, this packet, and `.agent/ORL-C3-FIXTURE-001-COMPLETION.json`. No source policy, production permissions, runtime profile, dependency, manifest, image, host, database, provider, PR2, commit, or remote changes.

**Failure evidence:** The actual 8f C3 attempt ended FAIL with zero certificates. Its last failing test was `verification-runner.test.js`; a temporary test fixture inherited the read-only `package-lock.json` mode through `copyFile`, then hit EACCES when the test wrote a stale lock. This packet repairs only the fixture setup. It does not reinterpret that cloud attempt or claim runtime acceptance.

**Repair:** Create a separate explicitly read-only temporary source fixture for the package lock. Copy source bytes into newly-created writable scratch files with exclusive creation; assert the scratch lock is writable, mutate only that scratch copy, retain the stale-lock admission rejection, and assert the read-only source fixture bytes and mode remain unchanged.

**Acceptance:** Focused test passes on the unchanged policy and preserves stale-lock rejection. Run typecheck, build, focused test, Node syntax check where applicable, and `git diff --check`. Controller owns integrated full gates, manifest/state updates, and any future runtime attempt. No runtime PASS is claimed.
