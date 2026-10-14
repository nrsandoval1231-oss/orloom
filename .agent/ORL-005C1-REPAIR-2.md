# C1a independent-review repair 2

Direction: CORRECT. Exact candidate `bb925e904d32dbc871f72de028e60d504c0a4773` closes the first three findings but received a further independent `FIX` on lesson-candidate eligibility. This is the second formal C1a repair. Preserve both rejected candidates and raw reviews. Promotion remains closed.

Core Luna owns the existing memory/SQL lesson extraction and a small shared cohort/eligibility helper in `packages/learning` if needed, plus its memory-store tests and docs/manifests. Second Luna owns only `tests/recovery-learning.test.ts` and outside-repository proof preparation. No schema or unrelated architecture change is expected. No source changes in PR2, deployment, credentials, provider calls, or new resources.

1. Only **committed** failure and success decisions may form an eligible episode. A stored `passed` observation whose judgment is prepared, invalid, interrupted, or UNKNOWN is not success evidence. Require a committed receipt/decision in both stores, and preserve quarantined observations without counting them. Test one unresolved pass plus one valid episode produces no candidate, including the reverse order.
2. Use one explicit scope-cohort derivation for current and historical episodes in both stores. Memory currently admits same-repository episodes from different cohorts; SQL uses the first supplied scope while the current path sorts first. Test different cohorts and unsorted valid multi-scope plans. Keep target, repository, epoch, strategy, and policy bindings from repair 1.

Prefer a shared, small eligibility rule over independently patched inconsistent loops. Retain bounded queries and deterministic canonical hashing. Produce positive same-cohort committed-episode evidence and negative mixed-cohort/unknown/prepared evidence through memory and authenticated SQL/HTTP paths.

After focused regressions, freeze source/docs and refresh the manifest. Run final mandatory gates and obtain independent source PASS **before** starting the real PostgreSQL proof, then bind runtime results to that exact candidate. If unresolved after this repair, return the actual constraint for a bounded senior-specialist repair or another valid path; never relabel missing evidence as success. C1b and full product acceptance remain open.
