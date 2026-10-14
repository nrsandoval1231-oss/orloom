# Worker source composition validation — 2026-10-14

## Scope

The separate worker successor composes original PR #2 `639bff0759870d3522ae38d2887b75fe6c4297c7` onto merged repair PR #18 at `dca7ac78df8f1c26a7c5cd2e8c9cfcb904297c2c` (reviewed tree `89a4ce7510699f993ce807fc4fdd71d0dceb606a`). The [repair validation record](2026-10-14-consolidation.md) remains unchanged and does not certify these added worker files.

The v2 source includes broker/runtime/checkout components, a contents-read-only GitHub checkout helper and a hardened separately typed HTTP recovery transport. Twelve original PR #2 source/test files retain their Git blob identities in [the source-preservation manifest](../pr2-worker-source-manifest.json). Normal `apps/worker/src/main.ts` refuses before importing broker code, reading secrets, claiming work or calling providers, without an environment-variable bypass. Preserved `broker-main.ts` remains unaccepted as a deployment entrypoint.

## Independent acceptance

- [Independent v2 review](orloom-worker-v2-independent-review.md): acceptable for bounded source merge with normal startup disabled; no remaining material source blocker found.
- Build, typecheck, structure validation and diff checks: PASS.
- `npm exec --offline -c 'node --test --test-concurrency=1 dist/tests/*.test.js'`: **188/188 PASS**, zero skips/failures/cancellations, exit 0, 80718 ms. [Full independent log](orloom-worker-review-v2-serial.log).
- The earlier builder run's 187 passes/one skip was caused by npm discovery context for the existing npm smoke test. The independent run supplied ordinary npm lifecycle context and passed that test without changing source.
- [Review-time source manifest](orloom-worker-v2-reviewed-manifest.json): 122 files with SHA-256 and Git blob identities; file SHA-256 `9d46e5ce0550e94c59b753dd7e3a29f02c922693adea022ffd4c5ae1fe0fb4dc`. All 19 worker composition file bindings verified. Exact patch SHA-256: `b2a0e334ca0914cab9e0cd6e2c82ab77aef3cad1d31791b9f228c882f831911e`.
- Publication code equality is bound by the [114-file runtime/build/test/config manifest](orloom-worker-v2-runtime-manifest.json), SHA-256 `d37c1d2afbbe2c0f78018d62de311ba81eed84e741c43a1a7e42762c20c7f1e8`, extracted unchanged from the tested snapshot. Eight total documentation artifacts, including README, are excluded and assessed separately.
- The original 122-file manifest includes the earlier review-time README snapshot and remains unchanged. The independent reviewer separately assessed the current README, current-state/work-graph, finish-contract and worker-ledger boundaries and found them aligned with this source-only acceptance. Final publication must preserve runtime bindings and this documentation distinction.

The seven-defect repair's 167-test record is preserved unchanged. These 188-test results belong to the separate worker successor, not a reinterpretation of that older run.

## Composition boundaries

- Recovery transport binds complete action/snapshot/judgment, identity, digest, policy and counters; rejects malformed receipts; refuses redirects and bounds response size/time. It can exchange nonterminal typed progress with the actual Governor over loopback HTTP. No broker recovery execution loop is wired.
- Builder-local checks and generic R2 telemetry cannot become trusted check passes or certificates.
- Candidate bundles uploaded by the worker do not enter an independently observed verifier checkout without a controller-owned admission/import path. That importer is absent.
- Recovery checkpoint/strategy execution, owner cancellation, exact-container reconciliation and conservative interrupted-spend/quarantine release remain absent. The historical polling shutdown race and drain-rather-than-cancel behavior are not activation-ready.
- Normal controller startup still has no live judgment/scheduling/learning-activation adapter.
- No live worker, Jev or DeepSeek execution, Docker/runsc/real PostgreSQL acceptance, six productive lanes, end-to-end delivery or measured learning gain is established.

## Historical evidence and publication

[PR #2 provenance](orloom-pr2-evidence-provenance.md) identifies 40 evidence blobs, three historical state archives and three historical checkpoint documents for exact preservation. Those original controlled fixtures are historical evidence, not acceptance of this composition.

Publication identity is the containing Git commit and associated PR; no circular self-SHA is required. Source-merge eligibility, if independently accepted, is distinct from activation, deployment and a claim that a merge has occurred.

## Active-document consistency review

A separate documentation sweep reviewed the canonical integration directive, deployment, security, judgment/recovery, README and successor checklist/current-state boundaries. It confirmed that the old PR #2 freeze is explicitly superseded, configured source routes are distinguished from deployment/activation, historical C1a promotion semantics are not presented as current, Hostinger setup uses the correct directory, and local versus cloud cookie semantics are accurate. The historical PR #1 state reference was corrected to its explicit SHA. No remaining material contradiction was found in that scope; no runtime tests were rerun for these documentation-only changes. Canonical architecture is unchanged.
