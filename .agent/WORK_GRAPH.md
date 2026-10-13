# Orloom Work Graph

Canonical parent: docs/architecture/CANONICAL_HARNESS.md and the owner's complete harness directive. A bounded checkpoint never completes this parent. Only focused branches/PRs; no further direct-main commits or unverified merges.

| Node | Dependencies | State | Evidence / acceptance boundary |
| --- | --- | --- | --- |
| ORL-001 foundation | none | ACCEPTED LOCALLY | Foundation review and deterministic gates; no live worker |
| ORL-002 cloud connections | ORL-001 | PARTIAL | DO SSH/Codex subscription request and private R2 bucket proven; DeepSeek, runtime R2 credentials and Orloom GitHub App not connected |
| ORL-004 queue deployment | ORL-001 | DEPLOYED QUEUE ONLY | Main 41643d8, Hostinger HTTPS/auth/PostgreSQL persistence/restore proof; owner browser acceptance unresolved |
| ORL-ISO-001 worker isolation | ORL-002 | ACCEPTED SMOKE ONLY | infra/worker-isolation reviewed exact bytes; two gVisor probes; sustained build/six-lane capacity UNKNOWN |
| ORL-005A mission control | ORL-001 | ACCEPTED BOUNDED | Repair 1 closes four findings; frozen c418a11 manifest, 21 tests and independent PASS |
| ORL-PG-001 real database proof | repaired ORL-005A | PASS / CLEANED | Eight real connections, races, persistence, rollback and quarantine; controller repeat PASS; disposable resources removed |
| ORL-005B broker + DeepSeek | accepted A, ISO | READY FOR IMPLEMENTATION | Actual lease/checkout/tool-loop/candidate/evidence path; real model probe and secure credentials required for live acceptance |
| ORL-005C active stuck + learning | A, B | DEPENDENT | Bounded strategy change and replanning; validated/versioned lessons influence active work; comparable-outcome measurements |
| ORL-005D integration + CI + PR | B, C | DEPENDENT | Serialized exact-head integration, clean independent checks/reviewer, immutable R2 evidence, scoped App publication; owner retains merge authority |
| ORL-005E real Living Loom | actual A-D events | DEPENDENT | Browser-to-verified-PR cloud proof and actual event weave; V1-V4 history preserved |

Reference sources were inspected read-only at Aura dc0466ee24de1c97205a21f66bbb2aec57d41e11 and Forge 462ce48294b3ee2f336a49a9cf475e24b541f29a. They supply reviewed concepts, not a pre-proven six-builder runtime. No source checkout was modified.

Current direction: CONTINUE B from independently accepted A and isolation-smoke checkpoints. Secure secrets-manager connection question is pending. No new spending authorized; no live provider results, throughput gains, learning gains or full-product completion established.
