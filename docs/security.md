# Security and credential handling

## Boundary and current limits

This foundation is single-operator and local. The dashboard token gates writes, and is stored in an HttpOnly, SameSite=Strict cookie after same-origin submission. The server compares it without logging values. The page sets no remote access policy; keep the server bound to loopback. The local in-memory store is not durable. Do not use the foundation for sensitive production work.

The worker has no execution protocol and exits closed. There is no shell endpoint, live GitHub API call, R2 call, Codex invocation, cloud database adapter, or deployed secret integration. The local webhook verifier and provider interfaces do not establish a secure production integration.

## Credential matrix

| Credential | Intended holder | Narrow scope | Entry and rotation |
|---|---|---|---|
| Orloom session token | Control-plane runtime | One operator session | Generate locally; later enter in provider dashboard as an encrypted runtime secret; rotate and revoke sessions |
| PostgreSQL URL/password | Control-plane runtime | Dedicated database and schema | Managed secret store; separate roles; rotate credential and verify connection |
| GitHub App private key | Forge/GitHub adapter only | App installation permissions for selected repositories | Generate in GitHub settings; store encrypted server-side; rotate key and revoke old key |
| GitHub webhook secret | Control plane | One app webhook endpoint | Generate independently; store encrypted server-side; rotate both ends together |
| R2 access key | Artifact adapter | Dedicated bucket, object operations needed only | Create scoped R2 token; store encrypted server-side; rotate and revoke old token |
| Codex SDK environment | Explicit execution adapter caller | Minimal per-run environment | Provide only explicitly selected variables to isolated runtime; never inherit the control-plane environment |

The example includes a blank `CODEX_API_KEY` placeholder for future worker-side use only. It is not configured for this foundation. Keep the key in the worker's dedicated secret store and pass only the required worker/Codex environment to the SDK adapter; never forward the control-plane environment.

Values must stay out of chat, Git, PRs, logs, telemetry, command output, browser bundles, and image layers. `.env.example` contains blank placeholders. Use ignored local files only for development and keep their permissions private. If a credential may have appeared in output or history, revoke/rotate it; deleting a file does not revoke it.

## External guidance

DigitalOcean App Platform distinguishes component-scoped encrypted runtime secrets from build-time values; administrators with console or source access can still access configured values, so access control remains necessary: [DigitalOcean environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/).

Create Cloudflare R2 tokens for the specific bucket and operations required, rather than reusing account-wide credentials: [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/).

GitHub Actions secrets are made available to Actions workflows according to repository, environment, or organization scope. That mechanism is not a runtime store for a separately hosted Forge worker: [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

These are setup references only; no credentials have been configured or tested.
