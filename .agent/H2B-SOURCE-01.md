# H2B-SOURCE-01: Hostinger worker preparation successor

Owner direction sets Hostinger as the target for the control plane, database and engineering workers. Worker execution remains disabled. This packet records the bounded documentation/configuration successor to exact source candidate `4203f3a1f379e60fb853ab48b04d389fe75e4978` (tree `cb60832ea4dd20a17613c60ddd7f407401e6fae0`). That source was accepted for its exact combined-source scope; its isolated runtime evidence is DigitalOcean-specific and is not Hostinger qualification. Controller-local external receipts are outside this Git tree and are not portable GitHub links; their workspace paths and identities are recorded in [current state](CURRENT_STATE.md).

The Hostinger GitHub App private key is staged at `/etc/orloom/credentials/github-app-private-key` with root-only `0400` metadata. Its controller-local external receipt is outside this Git tree and is not a portable GitHub link: `outputs/Orloom-Hostinger-worker/POSTCOPY.json`. This packet neither reads nor exposes the key. The app remains healthy with execution disabled; no worker or Orloom image is active.

## Host and preparation constraints

- Host `srv1758862` has 2 CPUs, about 8 GiB RAM, about 5.6 GiB available in the observed snapshot, and about 57 GiB free disk. Eight shared containers are protected.
- System Node `20.20.2` is below the repository engine requirement. Prepare private Node `24.15.0` at `/opt/orloom-worker-runtime/node-v24.15.0`; expected binary SHA-256 is `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`. Do not change global Node, Docker, host services or networking.
- Preserve the fixed v10 isolation suite: 1 CPU, 2 GiB RAM, 128 PIDs, nonroot, read-only, no network and no host binds; timeouts 1800/1830/1845/1860 seconds with a 2100-second ceiling. Build and verify sequentially under caps. Start with one lane; do not claim six-lane capacity.
- The source template is a non-activating preparation example. Leave `ORLOOM_WORKER_MODE` and `ORLOOM_WORKER_APPROVED_TASK_FILE` blank, capacity at zero, capacity evidence false, and integration/delivery false. Do not invent missing database, provider, R2, policy or image values or claim a positive config check.

## Ordered work graph

H2B source freeze -> H3 credential-free Hostinger image/runsc qualification and full fixed suite -> H4 separately reviewed disabled compatible release/preparation -> H5 owner-enabled mission. H3 and H4 remain OPEN until each has its own evidence and review. Backups, isolated restore and rollback evidence are required before compatible app cutover; a compatible v10 reader must precede v10 production records.

Acceptance for this packet is documentation/configuration only, focused `npm run validate`, `git diff --check`, and dotenv syntax/allowed-name checks that do not read secrets or contact the network. The candidate must be committed locally and frozen; final exact-candidate gates and independent review remain controller-owned. No application/package/runtime/test changes, secrets, remote activity, worker start, deployment, push, merge or activation are in scope. Preserve owner authority for activation, merge and delivery; the known `$1` mission cap remains unused.
