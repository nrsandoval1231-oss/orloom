# PR2 broker runtime checkpoint packet

Status: bounded fixture-only runtime proof. Live DeepSeek execution remains blocked and is not implemented in this harness.

## Identity and scope

- Node: ORL-005B broker/runtime checkpoint; branch `feat/deepseek-worker-broker`.
- Reviewed base commit: `6a128423d069718f37bcde34207806b9e35e826c`; working-tree source and proof harness are bound by `runtime-source-manifest.json`.
- The harness traverses production `executeLease`, the authenticated local HTTP claim/result protocol, and `DockerWorkerRuntime` on the existing Docker `runsc` host, using a deterministic provider double and local bare Git fixture.
- Allowed files: `work/worker-runtime-proof/**`, `.agent/CURRENT_STATE.md`, `.agent/WORK_GRAPH.md`, and `docs/FINISH_CONTRACT.md` for exact checkpoint claims. Production cleanup code and regression remain unchanged.
- Excluded: live provider calls, secret retrieval, spend-ledger mutation, push, merge, deploy, R2/GitHub publishing, protected host services, or new paid resources.

## Guard and acceptance

`prove-broker.mjs` accepts fixture mode only. Any other mode exits 2 with an explicit message before inspecting or creating `ORLOOM_PROOF_ROOT`; the harness contains no provider client, credential read, or spend-ledger code. `check-live-disabled.mjs` asserts this behavior using an isolated nonexistent root.

Acceptance requires the guard check, Node syntax checks, and a fresh fixture run through the actual broker/runtime path reaching only `awaiting_verification`, with candidate bundle and evidence readback, cancellation/cleanup, and protected-container equality. Retain previous proof reports and failures. Do not characterize fixture counters as real model usage.

Live credential retrieval, official pricing verification, capped spend reservation, and DeepSeek execution are explicitly incomplete. The last host metadata check found `/etc/orloom/infisical-client-secret` absent. The shared USD 5 cap remains USD 0 confirmed and USD 0 reserved. Do not attempt a provider call from this packet.

## Handoff boundary

Record exact candidate and source manifest, command, UTC report, image ID, safe runtime policy, and proof hash. GitHub App checkout, R2, production service bootstrap, Hostinger deployment, representative capacity, six live lanes, verifier/integration, and product completion remain UNKNOWN. No push, merge, deployment, or certification is authorized.
