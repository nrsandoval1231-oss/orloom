# PR2 live broker proof packet

Status: authorized bounded runtime and provider proof; no provider call until credentials, pricing, and spend reservation pass preflight.

Checkpoint: the remote nonbillable broker/runtime portion passed twice on 2026-10-13, including an independent controller repeat. See `RUNTIME-PROOF-RESULT.md` and `COMPLETION.json`. The provider portion remains pending because the expected `/etc/orloom/infisical-client-secret` file was absent; no retrieval or live call occurred and the shared USD 5 ledger remains fully unspent. The cleanup fix discovered by the run is included in the current working tree and awaits controller final gates/review.

## Identity and objective

- Node: ORL-005B live broker/runtime proof.
- Repository: `outputs/orloom`; branch `feat/deepseek-worker-broker`; candidate `8bbcfffbf631e5ad2972e34b41284198afc566e2`.
- Parent/base: `2d45b64e24817a14826a6c9466145909680fec0b`; PR2 remains stacked pending controller retarget after PR1 merge.
- Objective: traverse production `executeLease` with the real `HttpControlPlane`, `DeepSeekHttpClient`, and `DockerWorkerRuntime`, backed by the existing Docker `runsc` host, while retaining digest-verified candidate and evidence artifacts.
- Allowed mutation: `work/worker-runtime-proof/**`, one bounded `.agent` packet/completion/evidence record, and `infra/secret-bootstrap/**` only if the existing approved bootstrap needs a narrow repair. No production source, A/control-plane interfaces, Hostinger, R2/GitHub publishing, Docker daemon configuration, codex-universal, or new paid resources.

## Dependencies and preflight

- Current source review PASS applies to source only; verify exact candidate hashes before runtime execution.
- Use approved DO host alias `codex-dark-peak-5042`; capture protected `codex-universal` identity/status before and after. Never inspect OAuth/cache contents.
- Confirm the root-owned Infisical client-secret file by metadata only; authenticate only with the existing Orloom Development Viewer identity and retrieve only `ORLOOM_DEEPSEEK_API_KEY`. Never print, log, hash, or persist secret values or secret-bearing response bodies.
- Record a serialized shared spend ledger before any billable request. Aggregate authorized cap is USD 5 including model/tool probes. Reserve worst-case token cost before each request, settle only on confirmed usage, and retain unresolved reservations as UNKNOWN after ambiguous outcomes. No blind retry.
- Verify current model/API behavior and full peak pricing from official DeepSeek documentation, including cache-miss input, output, and reasoning charges. Bind an expiring pricing snapshot and safety margin before provider use.
- Build and invoke by immutable image ID/digest; inspect for `runsc`, nonroot, network none, read-only rootfs, no mounts/capabilities, bounded CPU/memory/PIDs, and exact owned-container cleanup.

## Proof design

- Use a disposable local bare Git repository and the reviewed `checkoutTransport` seam; immutable base-SHA validation remains in production `checkoutExact`.
- Use production `executeLease`, actual HTTP control routes/claim fencing, actual DeepSeek HTTP client, actual DockerWorkerRuntime, and filesystem-backed content-addressed evidence with readback hashes. No test provider or substitute runtime.
- Mission scope is a throwaway file and fixed trusted offline check. A result may reach only `awaiting_verification`; it is not verified, integrated, pushed, or a PR.
- If a prerequisite is missing, do not send a billable request. If a request may have been sent but response/usage is uncertain, record UNKNOWN and retain the full reservation.

## Acceptance and handoff

- Record exact source/image/base/candidate identities, safe Docker configuration, exact container IDs and cleanup, claim/heartbeat/result statuses, candidate bundle re-import and SHA, content hashes, provider model IDs and measured usage/cost, and protected-container before/after equality.
- Record each command/exit and UTC timestamp. Never include credentials, authorization headers, raw secret-manager responses, or raw model text.
- Explicitly leave GitHub App token, R2/cloud evidence, production worker service bootstrap, real Hostinger A deployment, representative build capacity, six-lane capacity, verifier/integration, and product completion UNKNOWN unless separately proven.
- At most two materially distinct repairs. No push, merge, deployment, or self-certification. Controller reruns final deterministic gates and performs independent review on the final candidate.
