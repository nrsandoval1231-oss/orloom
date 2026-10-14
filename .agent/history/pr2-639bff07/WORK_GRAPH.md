# Orloom Work Graph

Canonical parent: docs/architecture/CANONICAL_HARNESS.md and the owner's complete harness directive. A bounded checkpoint never completes this parent. Only focused branches/PRs; no further direct-main commits or unverified merges.

| Node | Dependencies | State | Evidence / acceptance boundary |
| --- | --- | --- | --- |
| ORL-001 foundation | none | ACCEPTED LOCALLY | Foundation review and deterministic gates; no live worker |
| ORL-002 cloud connections | ORL-001 | PARTIAL | DO SSH/Codex subscription request and private R2 bucket proven; DeepSeek, runtime R2 credentials and Orloom GitHub App not connected |
| ORL-004 queue deployment | ORL-001 | DEPLOYED QUEUE ONLY | Main 6110c692, Hostinger HTTPS/auth/PostgreSQL persistence/restore proof; owner browser acceptance unresolved |
| ORL-ISO-001 worker isolation | ORL-002 | ACCEPTED SMOKE ONLY | infra/worker-isolation reviewed exact bytes; two gVisor probes; sustained build/six-lane capacity UNKNOWN |
| ORL-005A mission control | ORL-001 | ACCEPTED BOUNDED | Repair 1 closes four findings; frozen c418a11 manifest, 21 tests and independent PASS |
| ORL-PG-001 real database proof | repaired ORL-005A | PASS / CLEANED | Eight real connections, races, persistence, rollback and quarantine; controller repeat PASS; disposable resources removed |
| ORL-005B broker + DeepSeek | accepted A, ISO | FIXTURE RUNTIME PASS; LIVE PATH NOT IMPLEMENTED; REVIEW PENDING | `work/worker-runtime-proof/runtime-source-manifest.json` binds the reviewed commit and working tree. Post-review harness rerun exercised production `executeLease`/HTTP/DockerWorkerRuntime on the existing runsc host; candidate bundle and 34 evidence items read back; cancellation/cleanup and protected-container equality passed. Sol found unsafe stale-pricing refresh and rounded-spend logic in old live branch; removed entire live branch and added a pre-resource fail-closed guard test. Infisical client-secret file absent; no retrieval or DeepSeek calls; shared cap remains USD 0 used/reserved of USD 5. Previous reports and failures retained. Controller final gates and independent review pending. |
| ORL-005C active stuck + learning | A, B | DEPENDENT | Bounded strategy change and replanning; validated/versioned lessons influence active work; comparable-outcome measurements |
| ORL-005D integration + CI + PR | B, C | DEPENDENT | Serialized exact-head integration, clean independent checks/reviewer, immutable R2 evidence, scoped App publication; owner retains merge authority |
| ORL-005E real Living Loom | actual A-D events | DEPENDENT | Browser-to-verified-PR cloud proof and actual event weave; V1-V4 history preserved |

Reference sources were inspected read-only at Aura dc0466ee24de1c97205a21f66bbb2aec57d41e11 and Forge 462ce48294b3ee2f336a49a9cf475e24b541f29a. They supply reviewed concepts, not a pre-proven six-builder runtime. No source checkout was modified.

Current direction: CONTINUE B after controller final gates and Sol review. The USD 5 aggregate DeepSeek cap remains unspent: confirmed USD 0, reserved USD 0. Live execution remains blocked and unimplemented here pending verified credential bootstrap, official current pricing, and a separately reviewed cap-reservation path. The remote fixture result does not count as live provider validation or verification. No throughput gains, learning gains, or full-product completion established.

A accepted head: 2d45b64e24817a14826a6c9466145909680fec0b, PR1 merged at `6110c692f47202978b2d22d22f6522aa4aa59277`. B remains on its stacked branch pending retarget/reconciliation; no push, merge, or production deployment. B owns worker/broker; separate narrow GitHub checkout token adapter has disjoint ownership. Actual Sol planning remains a required open path in the parent objective; manual plan provenance is not Sol execution. See `work/worker-runtime-proof/RUNTIME-PROOF-RESULT.md` for exact run boundaries and retained evidence.
