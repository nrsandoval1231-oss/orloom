# PR2 remote broker/runtime checkpoint

This is a bounded runtime checkpoint, not PR2 acceptance or product completion. The run reached `awaiting_verification` using production `executeLease`, `HttpControlPlane`, and `DockerWorkerRuntime` on the existing host, with a deterministic fixture provider. No live DeepSeek or credential retrieval occurred.

## Exact run and source

- UTC: 2026-10-13 18:25:14Z–18:25:20Z; run ID `orloom-pr2-20261013182514-1d792e61`.
- Branch/head: `feat/deepseek-worker-broker` at committed HEAD `8bbcfffbf631e5ad2972e34b41284198afc566e2`; relevant working-tree source is bound by [runtime-source-manifest.json](runtime-source-manifest.json), SHA-256 `cc44ff425c91f7ef9b6422817b61f93adf66b1ffa11c841c99294c30332717c5`.
- Remote report: `/var/lib/orloom/pr2-live-proof-20261013/orloom-pr2-20261013182514-1d792e61-UgtyWu/runtime-proof.json`; retained as [runtime-proof-pass.json](runtime-proof-pass.json), SHA-256 `bfb0b15be5dba1be08c3ca7326bf9ed65a4825b3c635fe7cf6a26f9fc2ab2bb9`.
- Controller independently repeated the exact command after source freeze: run ID `orloom-pr2-20261013182821-7eb00659`, 2026-10-13 18:28:21Z–18:28:26Z. Retained as [controller-runtime-proof.json](controller-runtime-proof.json), SHA-256 `630e56836e1245396d5a718fc28f86e25df0198735868a89cdd9e74ec1ef095c`. All 32 compiled `dist` files matched between workstation and host; no extras. The controller run also passed with 34 artifacts, two runsc containers inspected and cleaned, cancellation rejected, protected container unchanged, no Orloom-owned containers left, and OAuth status authenticated (exit-only; no token was read).
- Run command:

  ```sh
  env ORLOOM_PROOF_MODE=fixture ORLOOM_PROOF_ROOT=/var/lib/orloom/pr2-live-proof-20261013 ORLOOM_CANDIDATE_SHA=8bbcfffbf631e5ad2972e34b41284198afc566e2 ORLOOM_SANDBOX_IMAGE_REF=sha256:8b5bcbe33141560166240c95a19f474d2b730324ec7f8861e763fac3fd9b00ad /var/lib/orloom/pr2-live-proof-20261013/runtime/bin/node /var/lib/orloom/pr2-live-proof-20261013/source/work/worker-runtime-proof/prove-broker.mjs
  ```

- Image ID: `sha256:8b5bcbe33141560166240c95a19f474d2b730324ec7f8861e763fac3fd9b00ad`, built from `node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd` and the candidate sandbox entry.

## Result

The authenticated local owner/worker flow claimed a lease, completed all 18 progress events (probe, read, patch, trusted check, candidate), and acknowledged the candidate as `awaiting_verification`. The candidate Git bundle was imported into a fresh bare repository and matched the exact candidate SHA in the evidence. Thirty-four content-addressed artifacts passed readback hash checks.

The two inspected containers used `runsc`, network `none`, read-only rootfs, user `65532:65532`, no capabilities, `no-new-privileges`, 64 PIDs, 256 MiB memory and swap, 0.5 CPU, and only `/tmp` and `/work` tmpfs mounts (Docker inspect `Mounts` was empty). The interrupted check RPC was rejected and its exact owned container was removed. Candidate cleanup was empty after completion. The protected `codex-universal` container stayed at ID `5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67`, original start time, zero restarts, and running status. Final metadata check found zero Orloom-owned containers.

The run used the deterministic fixture provider: fixture-only usage counters were 26 input and 21 output tokens across five synthetic completion turns; actual provider calls and billable tokens were zero. Pricing/model behavior was not exercised live. The host's `/etc/orloom/infisical-client-secret` file was absent, so Infisical retrieval and DeepSeek live validation remain blocked. The root-owned shared ledger remains USD 0 confirmed, USD 0 reserved, USD 5 remaining.

## Failure and repair record

Retained reports preserve all failed attempts: [attempt 1](attempt-01-runtime-proof.json), [attempt 2](attempt-02-runtime-proof.json), and [attempt 3](attempt-03-runtime-proof.json). Attempt 1 completed the candidate but cleanup failed because production invoked unsupported `docker rm --time`. That production defect is fixed by using `docker rm --force <exact-id>` after exact ownership-label inspection; a focused CLI-argv regression now guards the supported arguments. The exact two leftover IDs were verified against their Orloom ownership labels and removed before the next run. Attempt 3 then reached `awaiting_verification`; the remaining failure was only in the proof reader, which parsed evidence names containing a colon incorrectly. The parser now uses the final `:sha256/` marker; the final run passed.

## Boundaries

This proves the local broker protocol and real isolated Docker/runsc runtime on the existing host. It does not prove a live DeepSeek response, Infisical authentication/retrieval, GitHub App checkout, R2, production worker service bootstrap, Hostinger A deployment, PostgreSQL runtime on this host, representative build capacity, six concurrent live lanes, verifier acceptance, Git integration, PR publication, or full product completion. The generated candidate is only `awaiting_verification`.
