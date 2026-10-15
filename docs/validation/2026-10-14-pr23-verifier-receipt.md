# PR23 commit-bound verifier repair receipt

## Candidate chain

- Base: `e1ace83b814c38fb9c8b1f6eb26982c05d205ebf`.
- Final source candidate S: `7396750c540eeac538b98c7f05c0293bad98cd6a`.
- Evidence candidate E: `81067c0be674b3c1e1821144b69cc5b3eb736858`.
- Source manifest: [`PR23-source-sha256.txt`](../../PR23-source-sha256.txt), 5/5 entries, checked against S's committed blobs. E has not changed application, test, package, migration, or runtime source from S.
- Receipt R is this commit plus `.agent` handoff records and `PR23-receipt-sha256.txt`. The receipt manifest covers all repair artifacts changed since the base and explicitly excludes only itself. R identifies S and E; it does not claim to authenticate its own future contents.

## Verification

The verifier cloned S without hardlinks into a fresh user-local Linux cache path and confirmed the detached checkout SHA. On Ubuntu WSL2 x86_64, kernel `6.18.33.2-microsoft-standard-WSL2`, Node `v24.11.1`, npm `11.6.2`, the exact candidate passed:

Invocation from the repository root: `node docs/validation/slice1c-review-findings/verify-1c.mjs 7396750c540eeac538b98c7f05c0293bad98cd6a docs/validation/pr23-evidence-attempt2-20261014`.

- `npm ci --no-audit --no-fund` — exit 0, 3353.77 ms.
- `npm run typecheck` — exit 0, 2276.32 ms.
- `npm run build` — exit 0, 2522.91 ms.
- `npm run validate` — exit 0, 83.90 ms.
- `node --test tests/slice1c-verifier.test.mjs` — exit 0, 2/2.
- Focused journal, runtime intent, cancellation, claim regression, and mission/migration checks — exit 0, 65 passed, 0 failed, 1 skipped of 66.
- `npm test` — exit 0, 247 passed, 0 failed, 1 skipped of 248, 0 cancelled; 38507.47 ms.

The skipped test is `operational journal opening is Linux-only and cannot silently use portable validation` in `tests/runtime-journal.test.ts`. It deliberately skips Linux ownership and mode checks because those require the deployment-host acceptance lane. PGlite migration checks passed; no actual PostgreSQL was exercised.

The first attempt at S1 `2ae17930290c1f2ce0e45b20a16d34c689728bd0` used `/tmp`. Its full suite had 245 pass, 2 fail, and 1 skip. Both failures came from existing verifier-config tests applying their persistent-path guard to the `/tmp` checkout parent. The failed run is preserved in [`attempt 1`](pr23-evidence-attempt1-20261014/); the successful retry is in [`attempt 2`](pr23-evidence-attempt2-20261014/). The retry moved only the isolated checkout to the user-local persistent Linux cache. No historical Windows log was modified.

E's post-commit integrity check passed: source 5/5; Slice 0 11/11; Slice 1a 9/9; Slice 1b 9/9; Slice 1c 11/11; attempt 1 10/10; attempt 2 10/10. Raw output is retained at [`pr23-postcommit-integrity.log`](pr23-postcommit-integrity.log). The old Slice 1c `verification-after.txt` still records 10/10 and remains historical; this receipt and the committed 11-entry manifest supersede that stale count.

## Acceptance boundary

This is bounded exact-source Linux build and test evidence, not production runtime evidence. It does not establish runsc isolation, deployment-host journal permissions, actual PostgreSQL, live provider calls, cancellation propagation in an active worker, deployment, or product completion. Those Finish Contract gates remain open. Sol's review of R returned `FIX` for the README wording described below; independent review of exact R2 is pending. No acceptance verdict or merge is claimed here.

## Documentation review overlay

Independent review of R found that the README overview incorrectly said owner cancellation was unimplemented, despite Slice 1b implementing the authenticated owner request and durable store fencing. The overlay candidate R2 corrects that sentence: request/fencing are implemented, while propagation to a running worker, exact absence/reconciliation, and operational acceptance remain open. The S and E commits, their Linux results, historical Windows logs, and prior receipt R remain unchanged; R2 is a docs-and-handoff overlay only. Its receipt manifest binds the complete changed repair file set since the original base, except the manifest itself. This overlay is not an independent acceptance verdict.
