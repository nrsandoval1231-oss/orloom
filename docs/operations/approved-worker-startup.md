# One explicitly approved worker task

This source path runs one durably approved single-slice mission. It does not plan work or choose another queued task. The default worker entrypoint exits before secrets, database access or provider activity. This document describes configuration; it does not authorize activation. The owner-directed target is Hostinger; first complete the [Hostinger worker preparation and qualification gates](hostinger-worker-preparation.md). DigitalOcean-only runtime evidence cannot satisfy them.

Use an already accepted Linux host with preloaded digest-pinned worker and verifier images, runsc isolation evidence, one capacity slot and one lane. Existing private PostgreSQL, GitHub App, R2 and DeepSeek configuration is required. Do not put controller credentials in the sandbox. Keep journal, service lock, admission, verifier evidence, object stores and review artifacts in separate protected persistent locations. The service lock is an existing private regular file in a protected directory; the journal directory is private and owned. Do not use source or temporary directories for retained verifier/admission evidence.

Set `ORLOOM_WORKER_MODE=approved-single` and `ORLOOM_WORKER_APPROVED_TASK_FILE` to a private, owned, bounded JSON file with exactly these fields:

```json
{
  "version": "orloom.approved-worker-task.v1",
  "missionId": "00000000-0000-0000-0000-000000000001",
  "sliceId": "approved-slice",
  "repository": "owner/repository",
  "baseSha": "<40 lowercase hex characters>",
  "planDigest": "<SHA-256 of canonical approved plan slices>",
  "trustedCheckPolicyDigest": "<SHA-256 of configured trusted check ID array>",
  "maxBudgetCents": 100,
  "expiresAt": "<future ISO timestamp>",
  "workerImageRef": "<preloaded image@sha256:digest>",
  "verifierImageRef": "<preloaded image@sha256:digest>"
}
```

The durable mission must match the repository, base, exact approved plan, single slice and budget. The atomic targeted claim skips unrelated work without invoking model scheduling. Configure every worker/verifier policy field listed in `.env.example`, including a single trusted check, explicit model/provider allowlists, check-command file, current pricing file, counters, capacity evidence, image references, repository map and private path pointers. The execution reservation must cover worst-case configured token cost; pricing has positive rates and a safety multiplier of at least 1.2. Secret `_FILE` pointers take precedence over raw values, and unsafe files fail closed.

After building, configuration can be checked without reading secret contents, claiming work or contacting services:

```sh
node --env-file-if-exists=.env dist/apps/worker/src/main.js --check-config
```

A successful check validates configuration shape and nonsecret policies. It does not prove credentials, image availability, runtime acceptance or live delivery. With separate owner activation approval, the same command without `--check-config` acquires the service lock, inspects preloaded images, composes trusted admission/verifier/cancellation recovery, and attempts this task once. It never pulls images. Signals and manifest expiry interrupt execution; interrupted work remains UNKNOWN until trusted runtime reconciliation. Reserved spend is retained without authoritative billing evidence.

An independently certified candidate pauses awaiting review by default. Integration requires `ORLOOM_INTEGRATION_ENABLED=true`, the existing protected integration/review configuration and an exact private `ORLOOM_WORKER_INTEGRATION_REQUEST_FILE`. Review identity, candidate, epoch, checks, digest and tree must match. Delivery additionally requires `ORLOOM_DELIVERY_ENABLED=true`, an existing private controller delivery policy and exact `ORLOOM_WORKER_DELIVERY_COMMAND_FILE`. Restart with the same approved task and exact review request reconciles retained certificates and delivery effects rather than running another builder. No automatic merge occurs.

UNKNOWN runtime or delivery effects require operator inspection. Do not delete journal evidence or reset leases to force retries. Startup hides operational exception details to avoid exposing credentials. Inspect protected records through the existing trusted operator workflow.

Retained normal ABSENT proof is validated for the exact controller run and recorded as an observation, allowing review/integration/delivery restart without pretending cancellation has settled. The same proof can later settle genuine owner cancellation. Invalid, changed or UNKNOWN proof stops startup. A cancelled lease with no registered runtime uses the atomic no-runtime settlement fence; any registered SQL intent keeps it quarantined even if the file journal is missing. Exact one-check verification eligibility is queried for the approved mission/slice/current epoch, so unrelated queue pages cannot block recovery; prior final attempts and dispatch failures remain excluded.
