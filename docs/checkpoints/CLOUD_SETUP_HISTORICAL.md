# Orloom cloud checkpoint

Verified 2026-10-13 UTC. Foundation published at ccc78ab5975c7f8bee20b52a74eb48ca45cffb51.

## Connected
- Dedicated DigitalOcean worker codex-dark-peak-5042 (608538530), Toronto, $24/month, SSH ready.
- Worker-only ChatGPT subscription sign-in verified. A no-tool, read-only Codex request returned ORLOOM_CONNECTION_OK, exit 0, using gpt-5.5. The image default gpt-5.4 was unsupported; the dedicated configuration now selects gpt-5.5.
- Dedicated auth directory /var/lib/orloom/codex, outside /opt/orloom/jobs. Auth file metadata verified owner orloom, mode 600. No auth contents read or copied.
- Private Cloudflare R2 bucket orloom-artifacts created. Managed public domain disabled; no custom domain. Runtime credentials not configured.
- Provisioning heartbeat deleted.

## Proposed next resources (not provisioned)
- One DigitalOcean managed PostgreSQL single-node 1 GiB cluster, starting $15/month. Dedicated Orloom database and runtime role, TLS, trusted-source restrictions; no database credentials on worker.
- One App Platform 512 MiB control-plane service, $5/month. Dedicated encrypted runtime secrets, no build-time credentials, no automatic deployment before Forge validation. Availability and actual checkout price must be confirmed before creation.
- Incremental baseline approximately $20/month; combined with worker approximately $44/month, excluding taxes, storage/transfer/operation overages and existing subscriptions. Single-node database is an initial single-user setup, not high availability.

Pricing references:
https://docs.digitalocean.com/products/databases/postgresql/details/pricing/
https://docs.digitalocean.com/products/app-platform/details/pricing/

## Secure connection sequence
1. Finish and independently review production database wiring, authenticated worker transport and job isolation. Cloud mode currently refuses startup; do not expose the local scaffold publicly.
2. Obtain approval for additional recurring resources; create the managed database and control-plane secret destination.
3. Configure database connection through provider-managed secret binding. Do not copy connection strings into chat.
4. Register a private Orloom GitHub App restricted to the selected Orloom repository. Begin with metadata/read, contents/read and checks/write; add write permissions only for implemented owner-approved behavior. Store private key only in the Forge/GitHub service's encrypted secret destination. Worker receives only narrowly scoped short-lived job credentials when implemented.
5. Create bucket-scoped R2 object credentials into the artifact service's encrypted runtime secret destination. Never put master credentials in jobs; use bounded artifact capabilities.
6. Run live database, artifact round-trip, selected-repository GitHub check and isolated worker-job proofs against an exact candidate before claiming product readiness.

## Still incomplete
PostgreSQL, deployed control plane, GitHub App installation, R2 runtime authentication, disposable job sandbox, worker transport, external Forge scheduler and end-to-end product proof. CLI sign-in and a model response establish subscription connectivity only. They do not establish SDK compatibility or job isolation. Aura, forge-agent and other hosts remain outside scope.

## Hostinger assessment — 2026-10-13 UTC
Authenticated dashboard confirms existing KVM 2 srv1758862.hstgr.cloud: 2 CPUs, 8 GB RAM, 100 GB disk. Snapshot: CPU 2%, RAM 22%, disk 31 GB used (69 GB free). Prior near-full storage observation is superseded by this current dashboard snapshot. These are instantaneous readings, not peak-load measurements.
Seven existing containers are running: n8n, Traefik and five BPOS-related services including their database. No server or application changes were made. Proposed placement is a separate Orloom app/database stack with separate volumes, credentials and limits; retain the dedicated DigitalOcean coding worker. Do not reuse the BPOS database or alter its compose project. Existing paid VPS may avoid the proposed additional $20/month managed services, at the cost of self-managed database operations and shared-host availability. Deployment remains pending implementation and review.

## Deployed — 2026-10-13 UTC
Orloom queue-only control plane and private PostgreSQL now run on existing Hostinger KVM2 at https://orloom.srv1758862.hstgr.cloud . Commit 41643d8b210c98dd5b8b870e79f5a9902c83882b pushed and verified equal GitHub main; checkout clean. Independent review PASS after one repair. Fourteen tests, remote image/Compose, HTTPS login, cross-origin rejection, opaque secure session, app/database restart persistence, exact-row backup restore all passed. All nine original containers retained identities/start times/restart counts; n8n health200. No additional hosting subscription purchased.

Cloud secrets remain outside Git and image in restricted Hostinger runtime files. No token values printed. Browser automation was blocked by the client, so interactive browser acceptance and secure owner credential delivery remain open. This is a working persistence/authentication foundation, not the finished Orloom product. Worker execution, GitHub App/R2 runtime connections and off-host scheduled backups remain incomplete. DO worker still bills at $24/month.
