# PR26 verifier capacity follow-up

Formal [review 5538859140](https://github.com/nrsandoval1231-oss/orloom/pull/26#pullrequestreview-5538859140) confirms the shutdown/long-expiry repairs but supersedes acceptance of 2dc187651b2616f8274eba31b07862ffaffafbc6. The added `await guard?.()` yielded before incrementing `active`, so concurrent calls both observed capacity1 as free. Even an absent guard yields at await. This was a new regression introduced by the lifecycle correction.

The bounded correction reserves the execution slot synchronously before the first lifecycle await, holds it through the admitted launcher, and releases in finally for guard rejection, cancellation, expiry or launcher failure. It rechecks request expiry after an awaited guard immediately before sandbox dispatch. Existing shutdown fences, UNKNOWN outcomes, shared admitting-facade capacity and artifact retention remain. Capacity bounds sandbox execution; artifact persistence after execution does not consume a runtime slot.

Deterministic actual fail-before evidence uses unchanged 2dc runner SHA-256 0ba352c0f4c635a5e5a01c03a7c7f54748be33fa6aea0545f7ef3e46af5bccc9: clean build; seven tests/four pass/three fail. Both immediate and delayed contention peak at 2 despite limit 1; expiry during guard still launches 1 instead of0. Controls pass for stopped guard, in-flight cancellation retaining capacity, launcher throw/UNKNOWN/failure and artifact-persistence failure. Initial helper exact-optional-property compile error is retained separately, not behavioral RED. Tests use explicit synthetic request/artifact/launcher seams, not actual verifier/runsc proof.

Evidence is in `docs/evidence/validation/2026-10-15-pr26-verifier-capacity/`. Final source freeze, focused/full Linux suite, build/typecheck/validate, hash reconciliation and independent bounded review follow. SQL/store authority is unchanged; prior actual PostgreSQL transcripts remain bounded supporting evidence, not new concurrency proof.

UI successor implementation and combined validation are saved locally atda09d1987db9db13cfaa8b632fd48d77bba0be99, unpublished. Its373-test green run does not override this base defect. Rebase/revalidate it after corrected PR26 publication. Independent reviewer owns merge. No merge, deployment, credential/provider activation or worker-created GitHub delivery occurred. Separately authorized Hostinger opt-in runsc preparation has private operational evidence and does not certify this source or enable paid AI.

| Gate | Result |
| --- | --- |
| Focused concurrency/lifecycle tests | PASS 28/28; seven new deterministic cases plus admission/coordinator lifecycle controls |
| Build/typecheck/validate | PASS |
| Full serialized Linux suite | 370 total,368 pass,zero failures/cancelled,two existing skips;145682.771376ms |
| Source/compiled/staged hashes | 187 source and124 compiled entries match, including staged Git blobs |
| Independent bounded source review | PASS; manifest046b011c9c09cf84e8fadfd938ca55513ca90a3acf3821d2577e02b162a9a161 |
| Exact publication-head external review | OPEN |
| Live execution/product completion | OPEN |

Final Node24.22.0 persistent Linux snapshot and post-run hashes passed. The seven new tests are controlled launcher/artifact fixtures and do not prove runsc/provider acceptance. Exact publication SHA/tree are recorded in PR26 and the handoff. External review remains OPEN. Earlier shutdown/delivery and timer tests continue to pass in the full suite.
