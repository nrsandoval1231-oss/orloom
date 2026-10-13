# Orloom Work Graph — revised owner directive

Canonical parent: docs/architecture/CANONICAL_HARNESS.md. Full product acceptance remains open.

| Node | Dependencies | State | Evidence and acceptance boundary |
|---|---|---|---|
| Mission control PR1 | foundation | MERGED VERIFIED BOUNDED | main 6110c692, exact-head independent review, 21 tests and fresh real PG proof; docs/evidence/pr1-revalidation |
| Worker broker PR2 | PR1 | FROZEN | 8bbcfffb, unchanged; no work on branch or broker implementation |
| C1a Jev + bounded recovery + lesson candidates | merged PR1 | IMPLEMENTING | .agent/ORL-005C1.md; official SDK0.6.0, fenced progress/decision contract, Governor authority, durable PG events; promotion closed pending independent evidence verifier |
| C1a real PG proof | frozen C1a source | PREPARING | Actual controlled executable recovery, candidate durability, promotion denial; no provider or learning-gain claims from fixtures |
| C1b full recovery signals + validated learning loop | C1a, C3 verifier | OPEN | Original C1 acceptance remains: independent challenge, versioned promotion/withdrawal, later comparable decision changes; also broader stuck signals and evaluation |
| C2 Athena adaptive scheduling | C1a, C1b for lessons | DEPENDENT | Eligible critical-path/cost/risk alternatives only, same deterministic scheduler and budgets |
| C3 Orloom CI | PR1, trusted policy | NEXT AFTER C1a | Exact commit, isolated real execution, immutable evidence, independent review, stale certification rejection; required before lesson promotion |
| C4 integration and PR delivery | C3 | DEPENDENT | Serial dependency-aware integration, conflicts, scope isolation, GitHub App; no product auto-merge |
| C5 real-event Living Loom | C1-C4 events | DEPENDENT | Existing circular design and V1-V4 history preserved; no synthetic completion |
| Cloud end-to-end/recovery | C1-C5, credentials | BLOCKED EXTERNAL AND IMPLEMENTATION | Jev/DeepSeek/App/R2 runtime auth, real model/capacity and independent outcomes not yet proven |

Current direction: REDIRECT the implementation order to C1a -> C3 -> C1b/C2. This preserves the full learning requirement while preventing worker assertions from becoming verified lessons. PR2 is not an integration dependency. Core builder owns contracts/store/migration/gateway/recovery/lessons/routes; second builder owns tests/recovery-learning.test.ts and root work/c1-runtime-proof. Controller owns canonical state, graph and prior proof records. No production deployment or new paid resources. Jev live spend is not authorized. The earlier $5 allowance is only for first DeepSeek validation, whose frozen broker is untouched.
