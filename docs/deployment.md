# Hostinger deployment: historical baseline and rollout boundary

The retained ORL-004 Hostinger baseline hosts only the Orloom web control plane and PostgreSQL queue. That historical deployed release has no worker, provider credentials, job lease loop or execution route. The current source is broader than that release; this document does not report a new rollout. A healthy queue does not establish product readiness or authorize a job to run. The separate DigitalOcean worker, OAuth, R2 credentials, Forge checks, evidence verification, and full Finish Contract remain independent gates.

ORL-005A mission tables and broker routes were merged through PR #1; repair PR #18 and the separate worker-source successor add further reviewed source without establishing deployment. The retained deployment baseline remains ORL-004 until an explicitly authorized rollout and migration validation. Do not set `ORLOOM_CAPACITY_SLOTS` above zero without operator-verified isolation evidence, trusted checks, provider/model allowlists, and positive spend/time ceilings. Current source contains a configured trusted verifier, owner-authenticated certificate reads and Governor-controlled integration routes. Those code paths do not mean verification is activated, independently certified or deployed. Normal worker startup stays disabled; candidate admission/import, recovery execution and cancellation/reconciliation are still open. See [foundation status](FOUNDATION_STATUS.md), [verification configuration](verification.md) and [worker acceptance](validation/2026-10-14-worker-composition.md).

## Historical baseline setup (requires explicit rollout authority)

Run on the Docker host from the repository checkout, with Docker Compose v2, OpenSSL, and the existing external Traefik network. This stack uses project name `orloom`, services `app` and `db`, and the private volume `postgres_data`. It only joins `${TRAEFIK_NETWORK}`, which defaults to `n8n_default`, for edge routing; PostgreSQL has no published port. Router hostname, entrypoint, resolver, and public origin are explicit configuration and must agree with DNS/TLS.

From the repository root, first run `cd deploy/hostinger`; the `.env.example`, `init-secrets.sh` and `compose.yml` referenced below are in that directory. Copy `.env.example` to `.env` and confirm the configured hostname resolves to this host, Traefik has the named resolver/entrypoint, and its Docker network exists. Run `./init-secrets.sh orloom.srv1758862.hstgr.cloud` as root only when initializing an empty secret directory. It generates random admin DB, app-role DB, and session tokens without printing them, writes the HTTPS origin and internal app DB URL, refuses to overwrite existing secret files, and sets restricted file access. PostgreSQL bootstrap creates `orloom_app`, which can create objects in the Orloom schema for idempotent migrations but is not a PostgreSQL superuser. The app runs as UID/GID 10001; the script grants that identity read access to its three mounted secret files. The DB password file stays root-owned because the official PostgreSQL entrypoint reads it before dropping privileges. The app-role password is owned by the PostgreSQL Alpine identity (UID/GID 70), mode 0400, and is mounted read-only into the database container.

For an existing installation with the original secret files, do not rerun the generator and do not replace any values. From `deploy/hostinger`, narrow only the existing app-role password file's metadata:

```sh
chown 70:70 secrets/app_password
chmod 0400 secrets/app_password
test "$(stat -c '%u:%g %a' secrets/app_password)" = '70:70 400'
```

This metadata-only correction leaves all secret contents intact. Never copy secret files into Git, a build context, image, ticket, terminal transcript, or backup stored beside this host.

Build/deploy serially from `deploy/hostinger`:

```sh
docker compose --project-name orloom -f compose.yml --env-file .env config --quiet
docker compose --project-name orloom -f compose.yml --env-file .env up -d --build --wait
```

Check `app` and `db` health, then load the HTTPS hostname. Writes require that exact Host and Origin; forwarded host headers are ignored. The health endpoint reports process status only. Cloud startup refuses absent database URL, token, host, or explicit HTTPS origin. Migrations run transactionally and idempotently before the listener starts. Run one app replica: cloud sessions are stored in process memory as random opaque IDs with an eight-hour expiry, Secure, HttpOnly and SameSite=Strict. Restart invalidates existing sessions; authenticate again.

## Backup and restore

Stop queue submissions by stopping `app`, then create a compressed logical backup. Keep the backup encrypted and outside the checkout, preferably off-host with a restricted retention policy. These examples do not print credentials:

```sh
docker compose --project-name orloom -f compose.yml --env-file .env stop app
umask 077
docker compose --project-name orloom -f compose.yml --env-file .env exec -T db sh -c 'PGPASSWORD="$(cat /run/secrets/db_password)" pg_dump -U orloom_admin -d orloom -Fc' > /secure-backup-location/orloom-$(date -u +%Y%m%dT%H%M%SZ).dump
docker compose --project-name orloom -f compose.yml --env-file .env start app
```

To restore, stop `app`, preserve the current volume and verify the chosen backup before replacing data. Restore into a newly created empty database/volume using the same secret files, then start `app` and verify health and a known queued row. Keep the previous volume until the restored state is confirmed. Never run restore against the only copy of the current volume. A restore test against an isolated copy is required before operational reliance.

## Rollback

Serialize releases. Record the running image ID and deployed Git SHA, build and health-check the candidate, then switch traffic only after app and database health pass. On app failure, restore the prior app image/tag and restart only `app`; do not roll the schema backward automatically. The current migration is additive/idempotent. Preserve the database volume and capture logs with secret values redacted before diagnosis. If data compatibility is uncertain, stop submissions and restore the pre-change backup into an isolated volume before changing production data.

This repository has not been deployed by this packet. Host runtime behavior, remote backup/restore, TLS issuance, and live browser use require the controller's separate authorized verification.

