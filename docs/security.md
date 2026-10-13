# Security and credential handling

## Boundary and current limits

Local mode is single-operator and loopback-bound, with an in-memory queue. The optional Hostinger cloud mode is a queue-only control plane backed by PostgreSQL: it has no worker execution path and does not establish product readiness. Cloud writes require the configured HTTPS origin and exact Host header; forwarded host headers are not trusted. The browser receives an opaque random eight-hour HttpOnly, Secure, SameSite=Strict session cookie, while the configured login token stays server-side. Sessions are in process memory, so the deployment must remain a single app replica and restart invalidates sessions.

The worker has no execution protocol and exits closed. There is no shell endpoint, live GitHub API call, R2 call, or Codex invocation from the Hostinger stack. PostgreSQL uses a separate `orloom_app` login for migrations and queue access; the app container does not receive the DB bootstrap superuser password. Host-managed Compose secret files are mounted at runtime and excluded from the image. Deployment, TLS issuance, backup restoration, and remote operation need separate verification; the local webhook verifier and provider interfaces do not establish those integrations.

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
