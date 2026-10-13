# PR2 broker/runtime checkpoint

The fixture-only harness was rerun after Sol review on the existing DO host. The current candidate reached `awaiting_verification` through production `executeLease`, `HttpControlPlane`, and `DockerWorkerRuntime`, with deterministic local provider behavior. This is not a live DeepSeek result, verification, PR2 acceptance, or product completion.

## Post-review run

- Candidate: `feat/deepseek-worker-broker`, reviewed commit `6a128423d069718f37bcde34207806b9e35e826c`, plus working-tree changes bound by [runtime-source-manifest.json](runtime-source-manifest.json).
- UTC run: 2026-10-13 18:37:34Z, ID `orloom-pr2-20261013183734-9292bfc9`, duration 4,605 ms, exit 0.
- Remote report: `/var/lib/orloom/pr2-live-proof-20261013/orloom-pr2-20261013183734-9292bfc9-FCB7oW/runtime-proof.json`; retained as [post-review-runtime-proof.json](post-review-runtime-proof.json), SHA-256 `831a7302d99cc3f0565fb8af7570e1b2b5f76774537fc7e876c0a3fcfc4b7f02`.
- Command:

  ```sh
  env ORLOOM_PROOF_MODE=fixture ORLOOM_PROOF_ROOT=/var/lib/orloom/pr2-live-proof-20261013 ORLOOM_CANDIDATE_SHA=6a128423d069718f37bcde34207806b9e35e826c ORLOOM_SANDBOX_IMAGE_REF=sha256:8b5bcbe33141560166240c95a19f474d2b730324ec7f8861e763fac3fd9b00ad /var/lib/orloom/pr2-live-proof-20261013/runtime/bin/node /var/lib/orloom/pr2-live-proof-20261013/source/work/worker-runtime-proof/prove-broker.mjs
  ```

- Result: `awaiting_verification`; deterministic test double, zero live calls; two real runsc containers inspected; cancellation rejected and exact owned container removed; post-candidate cleanup empty; protected container unchanged.
- The candidate bundle and 34 content-addressed evidence items were read back with matching hashes. Fixture token counters are synthetic and do not measure provider usage.

## Review correction

Sol found that the previous dormant live branch refreshed pricing freshness from run time and rounded spend checks, so it could not support safe live billing claims. That branch has been removed entirely. The harness now accepts fixture mode only, contains no DeepSeek client, credential retrieval, or spend-ledger mutation, and exits 2 on any other mode before inspecting or creating the proof root. [check-live-disabled.mjs](check-live-disabled.mjs) passes and verifies the configured root remains absent after rejection. Live mode requires a separate reviewed implementation after verified pricing and credential bootstrap.

## Retained earlier evidence and boundaries

Earlier fixture reports remain available: [initial run](runtime-proof-pass.json), [controller repeat](controller-runtime-proof.json), and [attempts 1](attempt-01-runtime-proof.json), [2](attempt-02-runtime-proof.json), and [3](attempt-03-runtime-proof.json). The original successful runtime also exposed unsupported `docker rm --time`; production cleanup was corrected to `docker rm --force <exact-id>` after ownership verification and guarded by a CLI-argv regression. The controller compared all 32 compiled distribution files and reported no mismatches.

The host's expected `/etc/orloom/infisical-client-secret` was absent at the last metadata-only check. No Infisical retrieval or DeepSeek request occurred. The existing shared USD 5 ledger remains USD 0 confirmed and USD 0 reserved. GitHub App checkout, R2, production worker service bootstrap, Hostinger deployment, PostgreSQL on this host, representative build capacity, six live lanes, verifier/integration, PR publication, and product completion are unproven. No push, merge, deployment, or certification occurred. The generated candidate is only `awaiting_verification`.
