# Orloom current state

Updated 2026-10-16 UTC. Current owner objective: deploy the approved Forest & Brass Command Center and Live Loom to existing Hostinger Docker Compose/PostgreSQL/reverse proxy, then continue worker acceptance. Routine deployment decisions are delegated; workers stay disabled until actual security/verification gates pass. Canonical authority: docs/architecture/CANONICAL_HARNESS.md and docs/design/FOREST_BRASS_UI_V1_1.md. Prior state bytes are preserved unchanged in archive/2026-10-16-before-hostinger-ui-CURRENT_STATE.md.

## Repository and READY work

PR30 approved design documentation is merged at main8e35410cda8d29740f180630eb6dd94893ab7401. UI branch feat/forest-brass-hostinger in Orloom-hostinger-ui is based on that exact main. One Luna implements UI-H1 under HOSTINGER_UI_PACKET.md; no canonical specification, auth, Governor transition or worker activation changes. Required independent review and final exact candidate gates remain pending.

The parallel Orloom-live worktree preserves bounded FLW verifier-TMPDIR and worker-input repairs; neither is integrated into this UI release or operationally accepted. Do not overwrite its dirty source/evidence. Real nonbillable runsc verifier preflight on main15e312d failed because archive root0555 replaced writable /work permissions; exact cleanup succeeded. Real nonbillable worker checkout failed a legitimate init-secrets.sh filename guard; cleanupABSENT. Zero paid provider calls. These are failures, not live workflow acceptance.

## Hostinger truth

Working URL https://orloom.srv1758862.hstgr.cloud/ currently serves queue-only release41643d8b210c98dd5b8b870e79f5a9902c83882b, image sha256:1cbf54112ae4429649302f0ef533e9df7b79124bad9fdeb45a52de7932918cec, private PostgreSQL volumeorloom_postgres_data. Production has not been switched. A staged main15e312d image passed isolated synthetic startup, ten migrations, persistence, and old-image schema startup; this does not qualify the new UI image or production data. Private release evidence is under ../Orloom/hostinger-live-release. New same-host encrypted backup/isolated-restore helper is in preparation; historical off-host export rejection is retained separately. No production dump/restore has occurred yet.

## Operational boundaries and next action

Dedicated worker609803474 codex-dark-reef-b16d, IP165.22.171.100, sfo2, created2026-10-16T20:05:11Z, costs$0.03571/hour within owner$5 total infrastructure cap. Site/database remainHostinger. DeepSeek key is installed root-only; live GET/models succeeds, no paid attempt used. Owner approved one Orloom builder task max100 cents; GitHubApp/R2 runtime credentials remain absent. Credential creation is deferred while shipping UI. Provisioning heartbeat isPAUSED during activework.

Next: finish UI source, freeze and validate full Linux/browser candidate, independent Sol review, publish/merge exact GitHub candidate, build bound image, review/run safe encrypted same-host backup+isolated restore, deploy app-only preserving DB and rollback, verify actual TLS/auth/persistence/UI/worker-disabled state. No source test, prototype, synthetic record or healthy process alone closes worker or autonomous PR acceptance.