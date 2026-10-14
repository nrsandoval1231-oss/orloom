# Slice 1c validation — close outstanding review findings

Recorded 2026-10-14. Branch `slice/01c-review-findings`, parent `31a4f18` (Slice 1), base `86a972300708f9bc05f557c5c09efd1c0f7e2ba6`.

## What this slice is

Slice 1c closes the review findings raised on the two open PRs. Both PRs were rechecked live before editing:

- **PR #21** (Slice 0 → `main`), head `df5d9db1d4`; **PR #22** (Slice 1a/1b → `slice/00`), head `31a4f181` at review time and now.
- `main` is still `86a972300708f9bc05f557c5c09efd1c0f7e2ba6`. Both PRs remain open; `gh pr list --json reviewDecision` (authenticated) returns an empty decision for both, consistent with the fact that the only reviews on them are bot reviews.
- Every review thread is from `chatgpt-codex-connector[bot]`: one review and two line comments on #21, one review and three line comments on #22, plus one bot summary comment each. There are no human reviews and no unresolved replies. All five line findings are addressed below.

Three of the five were raised against commit `9fdc87e3f2`, an intermediate Slice 1a commit that was later amended; each was therefore re-tested against the current head rather than taken at face value.

## Findings and disposition

### F1 — PR #21 (P2): manifest coverage claim was too broad

**Confirmed.** Re-verified: `deploy/hostinger/compose.yml`, `deploy/hostinger/init-secrets.sh`, `deploy/hostinger/.env.example` and `deploy/hostinger/initdb/010-app-role.sh` are all tracked and all **absent** from the 119-file manifest, while [`docs/deployment.md`](../deployment.md) treats them as production deployment inputs. A change to service environment, secret generation or database bootstrap leaves all 119 hashes unchanged.

**Fixed by correcting the claim, not by rewriting frozen evidence.** The Slice 0 record and its machine-readable report now state: the manifest binds shipped runtime, test and build inputs; it does **not** bind the deployable tree and does **not** prove that no unlisted configuration input exists. The earlier sentence claiming "no unlisted tracked path is a runtime, test, build or configuration input" is explicitly withdrawn. `docs/validation/foundation-release/**` is frozen historical evidence and was not modified.

### F2 — PR #21 (P2): no retained locked-install evidence

**Confirmed.** `slice0-baseline/` retained typecheck, build, validation and suite logs but no `npm ci` output, and the table recorded package/vulnerability counts instead of a duration. The gate verdict that every command's exit code, duration and artifact were retained was unsupported for the locked install.

**Fixed.** The install gate was re-run and retained: `npm ci --no-audit --no-fund`, exit 0, **6610.4 ms**, 99 packages, log at [`slice0-baseline/npm-ci.log`](slice0-baseline/npm-ci.log). This is recorded as a **fresh measurement during Slice 1c, not a reconstruction** of the original Slice 0 install, whose raw output is not recoverable and is not claimed. The original claim is withdrawn in both the record and the report.

### F3 — PR #22 (P1): a valid `created → unknown → absent` history bricked the journal

**Confirmed at head; this was a real self-quarantining defect.** `recordReconciliation` permits `unknown → absent`, appending a fourth transition, but `parseEntry` capped `history` at three items and did not list `intent>created>unknown>absent`. The write therefore succeeded and the next access **quarantined the entire journal**.

Reproduced before the fix: `created → unknown → absent write: accepted` → `reopen: QUARANTINED: record fields are invalid`.

**Fixed** in `apps/worker/src/runtime-journal.ts`: the history cap is now the named `maxJournalHistory = 4` and the legal set is the named `legalJournalHistories`, extended with `intent>created>unknown>absent`. The longest reachable chain is `intent > created > unknown > absent`, because `recordCreated` requires a prior `intent` and `absent` is terminal.

### F4 — PR #22 (P2): the record cap quarantined the journal at its advertised capacity

**Confirmed at head.** `readAllLocked` allowed 10,000 records plus the lock file, so `recordIntent` could create record 10,001 — after which every access saw 10,001 records and quarantined the root. There was no pre-write guard.

**Fixed** in `recordIntent`: `rows.size >= maxJournalFiles` is now refused before writing, so the boundary fails closed instead of bricking the journal. Verified at the **real 10,000-record boundary**: at capacity a new intent is rejected with "Runtime journal record capacity is reached" and the reopened journal is still readable with all 10,000 entries.

### F5 — PR #22 (P2): artifact manifest hashes did not match committed blobs

**Already resolved at the current head; no Slice 1c change was needed.** The finding was correct against `9fdc87e`, where the retained logs were not committed and the hash list had been written from Windows working-tree bytes. Slice 1a's own follow-up amend force-added the logs and regenerated the list from committed blobs.

Re-verified independently during this slice against head `31a4f18`: **`slice0-baseline` 10/10, `slice1a-runtime-intent` 9/9, `slice1b-owner-cancellation` 9/9** listed hashes match the committed blobs exactly, with no missing or unlisted entries. Slice 1c does not claim to have fixed this.

## Discriminating regressions

`tests/runtime-journal-review-findings.test.ts` (new, 4 tests). Their discrimination was **measured, not assumed** — the suite was run against the pre-fix source with the fix reverted:

| Test | Pre-fix | Post-fix |
|---|---|---|
| a `created -> unknown -> absent` history is durable and readable after reopen | **FAIL** | pass |
| an illegal four-item history is still quarantined | pass | pass |
| unreachable histories are quarantined with the sequence reason | pass | pass |
| the journal accepts its last free record, refuses the next, and stays readable throughout | **FAIL** | pass |

Pre-fix run: **1/3 pass, 2 fail** (tests 1 and 3 of the then-3-test file). Post-fix run: **4/4 pass**. The two tests that pass both ways are guards, not discriminators, and an independent reviewer confirmed they are not vacuous: it neutered only the sequence check in a temp copy and `intent>created>unknown>created` was then accepted, which would fail test 2; and an over-strict capacity guard would fail test 4, which now asserts **both** sides of the real boundary (the 10,000th record is accepted, the 10,001st is refused, and the root stays readable at both points).

The tests also assert the *reason* for each quarantine rather than merely that opening throws, and cover post-`absent` terminality: after an `absent` transition, `recordCreated`, `recordUnknown` and `recordAbsent` are each refused and the root remains readable.

## Checks and results

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | — |
| Build | `npm run build` | 0 | — |
| Validation | `npm run validate` | 0 | passed |
| Focused | `node --test dist/tests/runtime-journal-review-findings.test.js` | 0 | 4 tests, 4 pass |
| Locked install (re-run) | `npm ci --no-audit --no-fund` | 0 | 6610.4 ms, 99 packages |
| Full suite | `npm test` | 1 | **248 tests, 234 pass, 13 fail, 1 skipped, 78958.04 ms** |

248 = 244 (Slice 1 state) + 4; 234 = 230 + 4. The 13 failures are unchanged and are exactly `tests/candidate-admission.test.ts`, refused by the documented Linux/POSIX private-root guard. No new failures, no file-level failures.

**Post-commit integrity verification.** [`verify-1c.mjs`](slice1c-review-findings/verify-1c.mjs) was re-run against the **committed** blobs (not the working tree, which would hide an uncommitted edit) after the fix commit:

```
docs/validation/slice0-baseline: 11/11 match
docs/validation/slice1a-runtime-intent: 9/9 match
docs/validation/slice1b-owner-cancellation: 9/9 match
docs/validation/slice1c-review-findings: 10/10 match
created -> unknown -> absent write: accepted
reopen after that write: readable, 0 entries
record cap: maxJournalFiles declared 10_000; read threshold present; pre-write guard present
```

`slice0-baseline` now lists 11 entries because `npm-ci.log` was force-added and included; every other list is unchanged. The working tree was clean at this point.

## Independent adversarial review of this slice

A reviewer with no builder context reviewed the corrected code and evidence (its own run: 247/233/13/1, focused 4-file run green, discrimination reproduced as 1/3 pre-fix). Verdict: **F3, F4 and F1 genuinely closed; F2 not closed as delivered; F5 re-broken by this slice.** Disposition:

| Finding | Disposition |
|---|---|
| **D1 (blocking, F2)** the "retained" `npm-ci.log` was ignored by `.gitignore` (`*.log`) and therefore **not in the repository at all** — the same failure mode as F5 | **FIXED**: force-added and now listed in the retained hash list. Verified with `git ls-files` and by re-running the integrity check against the committed blobs. |
| **D2 (blocking, F5 integrity, self-inflicted)** this slice edited `slice0-baseline/verification-report.json`, which that directory's `artifact-sha256.txt` covers, without regenerating the list; the integrity check only passed because the edit was still uncommitted | **FIXED**: `slice0-baseline/artifact-sha256.txt` and `slice1c-review-findings/artifact-sha256.txt` are regenerated from the committed blobs, and the check is re-run post-commit. |
| **D3 (low)** the record named branch `slice/01c-review-findings`, which did not exist | **FIXED**: the branch was created before the commit, so the claim is now true. |
| **D4 (low)** `reviewDecision` was asserted without a checkable command | **FIXED**: the record now cites `gh pr list --json reviewDecision` and states only what it returns. |
| **Missing regressions** the boundary test only proved refusal (an over-strict guard would pass), and post-`absent` terminality and other unreachable histories were untested | **FIXED**: the boundary test now asserts both sides at the real 10,000 limit; a fourth test covers five unreachable histories; test 1 covers post-`absent` terminality; quarantine assertions check the reason. |

The reviewer confirmed F3's legal set is exactly the eight reachable histories and F4's read/write boundary has no residual off-by-one. It could not verify the original Slice 0 install output (unrecoverable, and the record says so), the `6610.4 ms`/99-package figures beyond the retained summary, `reviewDecision` via unauthenticated REST, or any PostgreSQL/Docker/Linux behaviour.

## Evidence class and platform limitations

**Source and fixture only.** Exercised: worker-local filesystem durability at the real record-capacity boundary, journal transition acceptance, and documentation/evidence correction. **Not exercised:** actual PostgreSQL, Docker/runsc, Linux ownership/mode checks, live provider, cancellation propagation, publication. Linux execution remains unavailable from this host, so the 13 admission tests are still covered only by the retained snapshot evidence — they are never described as passed here.

## Remaining risks

1. `recordReconciliation` still cannot bind a *discovered* container ID to an `intent`-state entry; that is the Slice 2c reconciliation work, not a 1c finding.
2. The record cap is enforced per process with no cross-process lock, so two processes sharing a journal root remain unsafe.
3. `maxJournalHistory` and `legalJournalHistories` must stay consistent; the constant is named and commented, but the coupling is by convention rather than by construction.
4. Deployment configuration remains outside the manifest. Binding it needs a separate additional manifest; the frozen one was deliberately not rewritten.
5. No live PostgreSQL or Linux acceptance exists for anything in this stack.
