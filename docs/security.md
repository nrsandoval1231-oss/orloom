# Security and credential handling

## Boundary and current limits

Local mode is single-operator and loopback-bound, with in-memory job and mission state. Hostinger currently runs the earlier ORL-004 queue-only release. This branch adds durable mission state and broker protocol but is not deployed. Browser writes in cloud mode require the configured HTTPS origin and exact Host header; forwarded host headers are not trusted. Machine claim writes bypass browser-origin checks only when their separate bearer identity is configured and supplied. The browser receives an opaque random eight-hour HttpOnly, Secure, SameSite=Strict session cookie, while the configured login token stays server-side. Sessions are in process memory, so the deployment must remain a single app replica and restart invalidates sessions.

This branch adds a mission broker protocol but still has no worker runtime. Claims require a separate `ORLOOM_WORKER_TOKEN`; a lease callback also needs a short-lived lease token, capability token, mission/slice identity, and fencing epoch. Only candidate SHA and evidence references are accepted from builders; they cannot set verified or integrated status. No verifier or integration endpoint is exposed by this branch. Candidate callbacks leave slices awaiting verification and dependent slices waiting on that verification; arbitrary evidence strings cannot advance mission state. A bounded startup/periodic lease reconciler marks expired leases `unknown` without refunding budget or releasing quarantined scope and capacity.

Capacity defaults to zero. A positive `ORLOOM_CAPACITY_SLOTS` value is accepted only with `ORLOOM_CAPACITY_EVIDENCE_VERIFIED=true`, an evidence SHA-256, and a future expiry. The runtime persists up to six slot records. Claims remain closed without a trusted check policy, positive provider-call/input-token/output-token/wall-time ceilings, and non-empty exact provider and model allowlists. The values are operator-controlled; neither plans nor workers can expand them. The evidence flag is an operator attestation, not proof performed by this code.

PostgreSQL uses a separate `orloom_app` login for migrations and queue/mission access; the app container does not receive the DB bootstrap superuser password. Host-managed Compose secret files are mounted at runtime and excluded from the image. This feature branch is not deployed; deployment, TLS issuance, backup restoration, live worker isolation, provider metering, and verifier behavior require separate verification.

Budget reservations are cumulative and fail closed: claims reserve the full slice budget and do not refund on candidate completion or UNKNOWN. Expired or worker-reported UNKNOWN/BLOCKED outcomes retain their reservation and quarantine their slot and overlapping repository scope pending explicit reconciliation. There is no automatic retry or recovery route.

## Credential matrix

| Credential | Intended holder | Narrow scope | Entry and rotation |
|---|---|---|---|
| Orloom session token | Control-plane runtime | One operator session | Generate on host with `deploy/hostinger/init-secrets.sh`; store as a protected Compose secret; rotate deliberately and restart the app to revoke all sessions |
| PostgreSQL URL/password | Control-plane runtime | Orloom queue objects via `orloom_app` role | Host-only protected Compose secret file; never mount the bootstrap superuser password into the app |
| GitHub App private key | Forge/GitHub adapter only | App installation permissions for selected repositories | Generate in GitHub settings; store encrypted server-side; rotate key and revoke old key |
| GitHub webhook secret | Control plane | One app webhook endpoint | Generate independently; store encrypted server-side; rotate both ends together |
| R2 access key | Artifact adapter | Dedicated bucket, object operations needed only | Create scoped R2 token; store encrypted server-side; rotate and revoke old token |
| Codex subscription session | Dedicated worker only | ChatGPT subscription through Codex device authentication | Operator completes device login on the provider UI; persist the dedicated auth cache in a permission-restricted worker secret store |

The worker requires an explicit absolute `CODEX_HOME` outside its job workspace. Its Codex SDK is forced to ChatGPT login and rejects `CODEX_API_KEY`; there is no API-key fallback. Do not discover a home directory implicitly or copy desktop authentication into the worker. A configured path or auth file's presence does not establish a successful subscription login. For a dedicated worker, an operator must run `codex login --device-auth` there and enter the displayed code in the provider's official UI. Persist the resulting auth cache with restrictive permissions or in the worker secret store, and preserve refresh state across worker restarts. Never expose the cache to repositories, jobs, artifacts, logs, or build layers; do not mint API keys as a substitute. Subscription access is subject to provider account limits and is not an unlimited-usage promise. No login or live request has been performed.

Values must stay out of chat, Git, PRs, logs, telemetry, command output, browser bundles, and image layers. Root-only host directories and protected secret files are required; the app runs as UID/GID 10001 and can read only its session, origin, and app-role DB URL. `.env.example` contains blank placeholders; `deploy/hostinger/.env.example` contains routing values only. Use ignored local files only for development and keep their permissions private. If a credential may have appeared in output or history, revoke/rotate it; deleting a file does not revoke it.

## External guidance

DigitalOcean App Platform distinguishes component-scoped encrypted runtime secrets from build-time values; administrators with console or source access can still access configured values, so access control remains necessary: [DigitalOcean environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/).

Create Cloudflare R2 tokens for the specific bucket and operations required, rather than reusing account-wide credentials: [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/).

GitHub Actions secrets are made available to Actions workflows according to repository, environment, or organization scope. That mechanism is not a runtime store for a separately hosted Forge worker: [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

These are setup references only; no credentials have been configured or tested.
