# ORL-005B dispatch checkpoint

- Branch: `feat/deepseek-worker-broker`
- Base SHA: `2d45b64e24817a14826a6c9466145909680fec0b`
- UTC start: `2026-10-13T03:28:22Z`
- Scope: worker broker, DeepSeek tool protocol, exact checkout and worker evidence helpers, tests/docs. No controller/governor/schema/prototype/Hostinger/isolation-source edits.
- Contract: `orloom.worker-lease.v1`; claim `/api/worker/claim`; fenced heartbeat/result/outcome `/api/worker/missions/{missionId}/slices/{sliceId}/{heartbeat|result|outcome}`. `integrate` remains unavailable; candidate output can only enter `awaiting_verification`.
- Live gates: no connected DeepSeek credential, no narrow checkout token yet (adapter change owned by controller), and no proven source-transfer/runtime image. Live execution remains disabled until all are independently configured and verified.
Implementation evidence correction: Docker cp cannot access runsc tmpfs; the existing Universal image Node is inaccessible to the nonroot worker. B must use reviewed bounded stdin transfer and a digest-pinned nonroot-usable image. The 32 MiB smoke workspace is not representative build capacity. Neither a configured attestation nor synthetic transport proves these live gates.

Sol pricing decision: keep A contract unchanged. Its immutable reservation/model/call/token/time ceilings authorize the bound. B snapshots an operator-controlled model-specific pricing policy per lease, verifies provenance/expiry/all charge classes, calculates worst-case rounded cost with safety margin, and retains policy bytes/hash plus usage in immutable evidence. Never reprice an active lease. Missing/stale/unpriced inputs block calls. If later Governor settlement depends on rates, add persisted pricing binding at claim in a separate reviewed interface change; a digest-only field is insufficient.
