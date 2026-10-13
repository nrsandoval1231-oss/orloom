# Actual DockerWorkerRuntime proof: current source seam

## Current source finding

The current candidate has a narrow `DockerWorkerRuntimeOptions.checkoutTransport` seam. `DockerWorkspace.checkout()` passes it into production `checkoutExact(...)`. The transport supplies only a source to the fixed fetch operation; `checkoutExact` still validates the repository and full base SHA, executes the constrained Git fetch and detached checkout, and verifies `rev-parse HEAD === lease.mission.baseSha`. No directory or runtime override is needed.

`DockerWorkspace.checkout()` is Linux-only. The development machine is Windows, so proof must run on the existing dedicated DO worker. The old `run_proof.py` remains a sandbox protocol fixture and does not exercise the broker or provider. It cannot be used as PR2 runtime acceptance.

## Proof requirements

The live proof uses a disposable bare Git repository, a token provider that fails if called, an immutable built image ID, and a fixed trusted check map. It exercises the actual broker `executeLease`, HTTP control protocol, DeepSeek client, and DockerWorkerRuntime in one lease. It verifies source-to-sandbox transfer, a model tool call, fixed check, candidate commit/bundle, content-addressed evidence readback, awaiting-verification handoff, and exact container cleanup. These checks do not establish GitHub App checkout, R2, production worker bootstrap, representative build capacity, or six-lane capacity.

The earlier source-review findings on abortable write drain and exact ID/label cleanup were addressed in repair 1. Runtime evidence must still inspect exact container IDs/names after `close()` and establish the protected-container snapshot is unchanged; source tests alone do not prove Docker/runsc behavior.

## Runtime result (2026-10-13)

The actual remote runtime path now passes on the existing dedicated DO host. See [retained runtime evidence](runtime-proof-pass.json) and [bounded result](RUNTIME-PROOF-RESULT.md). The run exercised production `executeLease`, local authenticated HTTP claim/result routes, `DockerWorkerRuntime`, exact-SHA checkout through the existing transport seam, `runsc`, candidate/bundle creation, evidence readback, and cancellation cleanup. It used a deterministic provider fixture and ends only at `awaiting_verification`; it is not a DeepSeek call or verification.

The run exposed and fixed a production cleanup defect: the Docker CLI does not support `docker rm --time`, so cleanup left its stopped owned containers. Removal now uses the supported `docker rm --force <exact-id>` arguments, guarded by exact ownership checks. The CLI-argv regression and remote proof pass; earlier failed runtime records are retained alongside the pass.

The host's expected `/etc/orloom/infisical-client-secret` file was absent at the last metadata-only check. No Infisical retrieval or DeepSeek request was made. The shared host ledger remains at USD 0 confirmed and USD 0 reserved of the existing USD 5 cap. Real provider, GitHub App checkout, R2, production service bootstrap, representative build capacity, six-lane capacity, verifier/integration, and product completion remain unproven.
