# Orloom Work Graph — revised owner directive

Canonical parent: docs/architecture/CANONICAL_HARNESS.md. Full product acceptance remains open.

| Node | Dependencies | State | Evidence and acceptance boundary |
|---|---|---|---|
| Mission control PR1 | foundation | MERGED VERIFIED BOUNDED | main 6110c692, exact-head independent review, 21 tests and fresh real PG proof; docs/evidence/pr1-revalidation |
| Worker broker PR2 | PR1 | FROZEN | 8bbcfffb, unchanged; no work on branch or broker implementation |
| C1a Jev + bounded recovery + lesson candidates | merged PR1 | ACCEPTED BOUNDED ON FEATURE BRANCH | Source545279c, 51 tests; docs/evidence/c1a-runtime; promotion closed pending independent evidence verifier |
| C1a real PG proof | frozen C1a source | PASS BOUNDED | Actual controlled executable recovery, candidate durability, promotion denial, fencing and reconnect; cleanup confirmed; no provider or learning-gain claims |
| C1b full recovery signals + validated learning loop | C1a, C3 verifier | OPEN | Original C1 acceptance remains: independent challenge, versioned promotion/withdrawal, later comparable decision changes; also broader stuck signals and evaluation |
| C2 Athena adaptive scheduling | C1a, C1b for lessons | DEPENDENT | Eligible critical-path/cost/risk alternatives only, same deterministic scheduler and budgets |
| C3 Orloom CI | C1a, trusted policy | ACCEPTED SYNTAX PATH; FULL SUITE OPEN | Source765943e, 66 tests, source/runtime independent PASS; actual runsc-to-PG certificate, contention and exact-CID continuation; docs/evidence/c3-runtime. Full-suite source06a74ac reviewed/71tests; actual first attempt UNKNOWN/no certificate. Next: bounded timeout diagnosis; docs/evidence/c3-suite-first-run |
| C4 integration and PR delivery | C3 | DEPENDENT | Serial dependency-aware integration, conflicts, scope isolation, GitHub App; no product auto-merge |
| C5 real-event Living Loom | C1-C4 events | DEPENDENT | Existing circular design and V1-V4 history preserved; no synthetic completion |
| Cloud end-to-end/recovery | C1-C5, credentials | BLOCKED EXTERNAL AND IMPLEMENTATION | Jev/DeepSeek/App/R2 runtime auth, real model/capacity and independent outcomes not yet proven |

Current direction: CONTINUE C1a -> C3 -> C1b/C2. This preserves the full learning requirement while preventing worker assertions from becoming verified lessons. PR2 is not an integration dependency. C1a remains in draft PR3. C3 syntax source and runtime evidence are retained in draft PR4; its accepted source is 765943e. The next bounded node extends independent checks through a fixed offline suite; it does not open lesson promotion or integration. No production deployment or new paid resources. Jev live spend is not authorized. The earlier $5 allowance is only for first DeepSeek validation, whose frozen broker is untouched.
