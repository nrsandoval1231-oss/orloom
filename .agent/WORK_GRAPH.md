# Orloom Work Graph — revised owner directive

Canonical parent: docs/architecture/CANONICAL_HARNESS.md. Full product acceptance remains open.

| Node | Dependencies | State | Evidence and acceptance boundary |
|---|---|---|---|
| Mission control PR1 | foundation | MERGED VERIFIED BOUNDED | main 6110c692, exact-head independent review, 21 tests and fresh real PG proof; docs/evidence/pr1-revalidation |
| Worker broker PR2 | PR1 | FROZEN | 8bbcfffb, unchanged; no work on branch or broker implementation |
| C1a Jev + bounded recovery + lesson candidates | merged PR1 | ACCEPTED BOUNDED ON FEATURE BRANCH | Source545279c, 51 tests; docs/evidence/c1a-runtime; promotion closed pending independent evidence verifier |
| C1a real PG proof | frozen C1a source | PASS BOUNDED | Actual controlled executable recovery, candidate durability, promotion denial, fencing and reconnect; cleanup confirmed; no provider or learning-gain claims |
| C1b full recovery signals + validated learning loop | C1a, C3 verifier contracts | BOUNDED LEARNING SOURCE PASS; RUNTIME OPEN | Exact34727251, 82 controller tests, independent PASS; authentic trusted receipt/PG execution, operational activation, broader recovery signals and measured benefit remain open |
| C2 Athena adaptive scheduling | C1a, C1b for lessons | SOURCE PASS; INTEGRATED SOURCE GATES PASS; REVIEW OPEN | Source157fea3 passed 90 tests and independent PASS. Composed with PR7/C1b in integrated source 198156548804673a8ade8a8878c1368c9d3cd357; root 97-test/controller gates PASS. Exact independent review and runtime behavior remain open; deterministic scheduler, lease/budget/scope authority retained. |
| C3 Orloom CI | C1a, trusted policy | SYNTAX PATH ACCEPTED; SUITE SOURCE PASS; RUNTIME OPEN | Source6716d252 source review/focused gates PASS only. Prior exact 617c378 2GiB run UNKNOWN184619ms, zero certificates, no OOM observed; finite 360/390/405/420s timer policy is a trial. No runtime proof on 6716d252 or combined candidate. Evidence in docs/evidence/c3-suite-resource and measured-source packet. |
| C4 integration and PR delivery | C3 | DEPENDENT | Serial dependency-aware integration, conflicts, scope isolation, GitHub App; no product auto-merge |
| C5 real-event Living Loom | C1-C4 events | DEPENDENT | Existing circular design and V1-V4 history preserved; no synthetic completion |
| Cloud end-to-end/recovery | C1-C5, credentials | BLOCKED EXTERNAL AND IMPLEMENTATION | Jev/DeepSeek/App/R2 runtime auth, real model/capacity and independent outcomes not yet proven |

Current direction: CONTINUE C1a -> C3 -> C1b/C2. This preserves the full learning requirement while preventing worker assertions from becoming verified lessons. PR2 is not an integration dependency. C1a remains in draft PR3. C3 syntax source and runtime evidence are retained in draft PR4; its accepted source is 765943e. The next bounded node extends independent checks through a fixed offline suite; it does not open lesson promotion or integration. No production deployment or new paid resources. Jev live spend is not authorized. The earlier $5 allowance is only for first DeepSeek validation, whose frozen broker is untouched.

Latest C3 evidence: deadline candidate9ebc9d91 local73/sourcePASS but cloud UNKNOWN64177ms from exact sandbox OOM137, no certificates. docs/evidence/c3-suite-oom retains independent FIX, artifacts and cleanup. Direction CORRECT fixed test concurrency before new acceptance; no old UNKNOWN redispatch.

Serial candidate663af2c3 local74/sourcePASS but cloud attempt66260b4a UNKNOWN70340ms from exact OOM137; zero certificates. docs/evidence/c3-suite-serial-oom retains evidence and cleanup. REDIRECT to bounded active-file/memory diagnosis under unchanged limits. C1b source work proceeds independently with operational/runtime gates still closed; no blind third acceptance retry.

Diagnostic candidate4d1dd56 local75/sourcePASS, actualbdac22cd UNKNOWN60219ms/zero certificates. Five files finished; jobs.test.js started before exact OOM137. Bounded exact-CID cgroup samples and cleanup/protected-host proof are retained in docs/evidence/c3-suite-memory. Independent runtime FIX; no completion claim. Next direction: targeted memory correction supported by the retained diagnosis, then a distinct reviewed candidate. C1b mandatory source authority cases remain in progress; source acceptance, authentic runner/PG proof and cloud certification remain separate open gates.

C1b source34727251 now passed all82 controller tests and independent source review. The trusted learning loop and required source authority tests are implemented; real PG/runner proof, operational activation, broader stuck signals and measured benefit remain open. Evidence: docs/evidence/c1b-source. Direction CONTINUE source-independent C2 scheduling through the existing Athena/Governor path while C3 focused cloud repair proceeds separately. Jev live calls/spend remain disabled; no new scheduler or broker is authorized.

Focused successor to C1b PR6 snapshot7a6165e3: promotion now fails closed without controller-owned runtime activation. Independent cohort observations derive from retained slice scopes. Authenticated impact inspection retains later applied decisions and PASS/FAIL/UNKNOWN/pending attempts across reconnect and concurrent withdrawal. Two eligible alternatives demonstrate a changed controlled SDK decision after challenge/promotion. See docs/evidence/learning-activation-impact. Source behavior does not close authentic PG/runner, exact integrated cloud-suite, deployment identity or measured live improvement gates. PR2 frozen and unchanged.

Integrated source code SHA 198156548804673a8ade8a8878c1368c9d3cd357 passed root controller gates (97 tests, validation, syntax, diff); independent review is pending. A docs-only CURRENT_STATE/WORK_GRAPH successor is being prepared and must receive a fresh controller-issued SHA before package binding. No runtime acceptance claim. PR2 remains frozen.


Checkpoint 2026-10-13: combined source8f271de passed97 local tests and independent source review, but actual C3 attempt1fdeee6f returned FAIL297978ms/zero certificates. The final test file hit EACCES when mutating its read-only scratch lock; no timeout or OOM was observed. Fifteen prior files passed. Evidence/snapshot retained, exact disposable cleanup and protected-host postflight PASS. C1b actual learning proof remains blocked for this candidate. CONTINUE test-only fixture repair6406393 and C4 local integration, then C5 event viewer; compose and independently review a new source before cloud proof. Historical pending statements above are superseded by this checkpoint and CURRENT_STATE.

C4 checkpoint: local direct-child integration source5856fd5 and scratch fixture repair6406393 composed with cdad evidence. Final source gates/review pending on the frozen successor; production remains closed and actual full-suite cloud acceptance remains FAIL/zero certificates on prior8f. C5 may begin after C4 source acceptance and ownership release. PR2 external head639bff is excluded; owner-frozen baseline8bb remains protected.

Latest C4: exact078ed12 source98testPASS/independentPASS after f669 FIX, evidence docs/evidence/c4-source. C5 source READY/active on feat/live-loom from078; realPG proof preparation independent. Operational integration and cloud certification remain OPEN.

C5 source3d1be84 implemented; final gates/browser/independent review pending on composition with C4 evidence037. No operational or PostgreSQL acceptance. Delivery core proceeds on a separate branch and waits for serialized server route integration.

C5 checkpoint: 19abb354 source105PASS but independentFIX (visual, pagination, closure). Repair1 0c8c85de retained; final scope/camera correction and controller gates/browser/review next. Source does not establish runtime certification. Delivery core preserved f51d364 on separate branch; preliminary independentFIX for concurrency, per-effect recovery and external identity readback; repair in progress before serialized server integration.

Latest C5: bd2bb5e source110PASS/browserPASS/independentPASS bounded, evidence docs/evidence/c5-source-browser. Actual PG browser gate remainsOPEN. C4 realPG078 replayraceFAIL supersedes concurrency assumption; bounded source repair separate. Continue serialized delivery route after C5 source integration; root keeps originalfailedattempts.
