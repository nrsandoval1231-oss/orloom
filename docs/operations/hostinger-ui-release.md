# Hostinger control-plane and UI release

The approved Forest & Brass Command Center is served at `/`; Live Loom remains
the read-only `/loom` observer. PostgreSQL owns mission state. This release does
not activate an engineering worker, verifier, integration, or PR publisher.

Use the existing `orloom` Compose project and its private PostgreSQL volume.
Build the reviewed Git commit with `apps/control-plane/Dockerfile`, recording the
source archive digest, OCI revision label, and final local image ID. Load no
provider credentials into this web image or its build context.

Before switching the app, retain its current image ID, verify an encrypted
database backup and an isolated restore, and test candidate migrations against
that restored database with the non-superuser application role. Keep the previous
image and live database volume. A same-host backup supports rollback but does not
provide recovery from loss of the VPS; off-host retention is a separate gate.

The committed `deploy/hostinger/compose.release.yml` overlays an immutable,
already loaded app image. It fixes capacity at zero and leaves integration and
delivery disabled. Its check identifier is an allowed **plan requirement**, not
evidence that a verifier is configured or that any check has passed.

From `/opt/orloom/deploy/hostinger`, apply only the app after setting
`ORLOOM_RELEASE_IMAGE` to the reviewed local `sha256:<digest>` image ID:

```sh
docker compose --project-name orloom -f compose.yml -f /absolute/release/deploy/hostinger/compose.release.yml --env-file .env config --quiet
docker compose --project-name orloom -f compose.yml -f /absolute/release/deploy/hostinger/compose.release.yml --env-file .env up -d --no-build --pull never --no-deps --wait app
```

Rollback uses the same commands with `ORLOOM_RELEASE_IMAGE` set to the retained
previous app image ID. Never recreate or restore the live database for an app
rollback. Record the active overlay path so later maintenance preserves the
selected image and disabled-worker controls.

Verify actual HTTPS `/health`, application and database health, image ID and Git
revision, owner-session login, unauthorized and cross-origin rejection, durable
mission reads after app restart, mission create/plan/approve/cancel controls,
and Command Center/Live Loom behavior on desktop and mobile. A successful health
endpoint is process/database readiness only. Report worker/provider/GitHub
delivery acceptance separately.

Authentication uses the existing owner access key and an eight-hour opaque
HttpOnly, Secure, SameSite=Strict cookie. App restart invalidates sessions; sign
in again with the same key. Never place the key in a URL, browser persistent
storage, source control, logs, or release evidence.
