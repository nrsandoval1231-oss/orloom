# PR27 readiness and observed delivery revision repair

External review [5539182411](https://github.com/nrsandoval1231-oss/orloom/pull/27#pullrequestreview-5539182411) of dd589b81ff1445178ef9d11a27eea04dad39b849 reproduced two P2 findings. Prior UI acceptance is superseded for these mappings. Main f69e9098241879f922fc8f4b50549449d2e5d75c has the accepted PR26 tree 3a67fd3480c2d0b6951a1a965595055c6e2921e5.

The bounded correction must use actual coordinator support/identity in owner readiness and retain production observedRemoteSha delivery references. Canonical UI geometry, authentication, execution authority and fail-closed startup remain unchanged. Live execution remains unverified.

## Test-first evidence

Tests were edited before product code, then controller ran build and focused tests against unchanged product: build PASS, 6 tests /4 pass /2 fail. Failures were unsupported planned check returning ready and missing observed remote revision. Exact transcripts: [RED build](../evidence/validation/2026-10-15-pr27-readiness-observation/red-build.txt), [RED tests](../evidence/validation/2026-10-15-pr27-readiness-observation/red-tests.txt). Test-only readiness was reported before controller run and implementation was explicitly released afterward. The retained post-red-in-progress-product-diff.txt was captured after that release; it is not a baseline diff.

## Current acceptance ledger

| Gate | Status |
|---|---|
| Focused tests / adjacent mappings | PASS24/24; actual HTTP coordinator cases; broad-policy valid-subset unsupported-plan negative and supported-plan positive |
| Build / typecheck / validate | PASS final build-final.txt/typecheck-final.txt/validate-final.txt |
| Full Linux Node24.22.0 suite | PASS382total/380pass/0fail/0cancelled/2existing skips;154265.753814ms |
| Synthetic real browser | PASS_SYNTHETIC_BROWSER; desktop/mobile/auth/offline/reconnect/fresh context; no page errors or provider/worker/runtime activity |
| Actual isolated PostgreSQL | PASS;2connections/2HTTP restarts/auth/expired UNKNOWN/pre-runtime settlement;0read side effects; reserved100 retained; owned cluster stopped |
| Exact source / compiled / staged manifests | PASS192source/127compiled; zero mismatches before/after full run and staged verification |
| Independent bounded source review | PASS; exact manifest8de135882a6396b60aa8283801b431cd797f20a11498813e4d4673425461a96d; external review remains OPEN |
| Exact-head external review | OPEN; reviewer owns merge |
| Live worker/provider/verifier/GitHub delivery | OPEN; fixtures are not live |

No merge, deployment, paid provider activity or credential creation occurs. Separate approved host preparation is private outside Git and does not certify the UI or live product.

The initial restricted-loopback focused run failed to start local HTTP and was interrupted; retained as focused-restricted-loopback-interrupted.txt. The authorized loopback rerun and final focused run passed. The first full Linux run passed382total/380pass/0fail/2existing skips/153114.819593ms on manifest5df7ad2e; it is retained with before-subset prefixes. A final test-only addition isolates the exact reviewer scenario and prompted a new final build and full run. Earlier results are not substituted for final candidate acceptance.

[Adjacent mapping audit](2026-10-15-pr27-readiness-observation-adjacent-review.md) and [independent source review](../evidence/validation/2026-10-15-pr27-readiness-observation/source-review.md). Readiness reads one coordinator binding snapshot, checks actual support and exact configured identity/image/version/lease-policy consistency, and keeps verifier-policy digest separate from the operator allowlist digest. Delivery pending retains integratedSha; check/PR/UNKNOWN observations retain a valid observedRemoteSha, without using delivery references to infer closure. No schema or canonical page changes.

Final test fixture cleanup removes synthetic integratedSha from check/PR observations, matching SQL payloads literally. Browser and actual PostgreSQL final proofs ran before this test-only cleanup; byte reconciliation shows only tests/owner-readiness.test.ts and its compiled test changed, with every executed browser/HTTP/store/product/script byte unchanged. See browser-postgres-final-byte-reconciliation.json. Final focused24/24 passes and full suite is rerun for these final test bytes. Independent source review is refreshed to the final manifest.

Final reconciliation (2026-10-15T20:20:52.2761822Z): final Linux382total/380pass/0fail/0cancelled/2existing skips/154265.753814ms; final manifest8de135882a6396b60aa8283801b431cd797f20a11498813e4d4673425461a96d. Before-observation full run also passed382/380/0fail/2skips/153529.847601ms and remains historical. All final local gates PASS within their stated bounds. Exact-head external review and live product acceptance remain OPEN. Publication SHA/tree are recorded in the PR body and controller handoff; no self-referential committed SHA claim is made here.
