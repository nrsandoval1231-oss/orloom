# Explicit approved worker startup packet

Started 2026-10-15 17:08 UTC. Parent owner authorization: after PR25 repairs, keep it frozen and implement usable normal explicit-config startup on a clearly stacked branch/PR. Base `27b786b140a2f0f73141aa60175b939b8f6ba605`; branch `feat/explicit-approved-worker-startup`, eventual PR base `feat/approved-worker-composition` (do not merge either).

READY outcome: normal worker main can operate one exact owner-approved slice using existing Governor, concrete isolated Docker lane, trusted cancellation journal, independent verifier and explicitly guarded draft-PR delivery. Defaults remain disabled before secrets/network/claims. No model planning, autonomous paid calls, new credentials/hosts, deployment or security/network changes.

Composition boundaries:

- Add atomic targeted claim to existing stores/Governor. `ApprovedClaimTarget`: missionId, sliceId, repository, baseSha, planDigest, maxBudgetCents. Recheck approved exact single-slice plan, repository/base/digest/whole plan/check allowlist, budget, capacity and conflicts atomically. Never claim arbitrary work then reject it. No model scheduling for this one-target mode.
- Operator manifest `orloom.approved-worker-task.v1`: version, missionId, sliceId, repository, baseSha, planDigest, trustedCheckPolicyDigest, maxBudgetCents, expiresAt, workerImageRef, verifierImageRef. Private bounded owned regular file. `ORLOOM_WORKER_MODE=approved-single`, `ORLOOM_WORKER_APPROVED_TASK_FILE` plus complete existing worker/verifier/capacity config required; absent mode/task remains disabled. No production fixture environment bypass.
- Shared trusted startup service composes Governor-backed local ControlPlane adapter, not worker-facing settlement HTTP authority. No control-plane/database/provider credentials enter build sandboxes. Preserve broker/runtime architecture and private files. Reconcile interrupted runtime/settlement before first claim; refuse UNKNOWN and duplicate service ownership. Concrete runtime always receives bridge.
- Active service signal propagates into executeLease/preflight/provider/tool cancellation; drain cleanup before releasing service lock. OS interruption is UNKNOWN, not fabricated owner cancellation/refund. Restart means trusted reconciliation of persisted work; never silently reexecute an UNKNOWN or cancelled provider attempt.
- Existing Governor integrates certified candidate only with exact independent review artifact/request; existing guarded delivery requires explicit controller policy and exact draft-PR readback. Default off; no fabricated review/certificate or automatic merge. Source/tests exercise this with controlled adapters only.

Acceptance: regressions fail before implementation; pure/default/partial startup and actual entrypoint checks; exact target amid unrelated queued missions; two-pool real PostgreSQL contention/restart; concrete Docker wiring; active shutdown and cancellation stages; verifier and guarded delivery fixtures; build/typecheck/validate plus full serial Linux suite; exact source manifest; independent review; stacked PR publication.

Implementation ownership: bounded Luna packets for targeted claims, service lifecycle and normal-main/bootstrap. Controller coordinates interfaces, real database evidence, source review and publication. Source/test proof is distinct from live provider/runsc/remote delivery acceptance.

Live recommendation remains a two-file Orloom cancellation-label task, one lane/attempt, proposed 100-cent provider ceiling and explicit existing-host/credential/activation approval after runtime acceptance. No live authorization is inferred from this source packet.
