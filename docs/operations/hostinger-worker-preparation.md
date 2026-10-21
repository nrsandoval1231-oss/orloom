# Hostinger worker preparation

The owner selected Hostinger for Orloom's control plane, database and engineering workers. This guide records preparation prerequisites and evidence boundaries; it does not authorize worker activation, deployment, or a production mission. Execution remains disabled.

## Accepted source and provider boundary

Exact source `4203f3a1f379e60fb853ab48b04d389fe75e4978` (tree `cb60832ea4dd20a17613c60ddd7f407401e6fae0`) was accepted for the combined-source scope. Its isolated image/runsc qualification ran on DigitalOcean. That remains historical evidence for that provider and candidate; it does not qualify Hostinger. The controller-local external receipts are outside this Git tree and are not portable GitHub links: `outputs/Orloom-combined-v10/accepted-state.json` and `outputs/Orloom-combined-v10/SOURCE_REVIEW_PASS.json`. They preserve the exact scope.

The Hostinger GitHub App key has been staged at `/etc/orloom/credentials/github-app-private-key` as a root-owned regular file with mode `0400`. Its public App ID is `5351875` and installation ID is `172236296`. The controller-local external metadata-only receipt is outside this Git tree and is not a portable GitHub link: `outputs/Orloom-Hostinger-worker/POSTCOPY.json`. It records the path's metadata and confirms the eight protected containers were unchanged. Never read, print, copy, hash, or expose the key contents as part of this preparation. Staging is not worker configuration, provider authentication, or execution evidence.

## Host limits and fixed qualification profile

The observed Hostinger machine is `srv1758862`, with 2 CPUs, about 8 GiB RAM, approximately 5.6 GiB available in the recorded snapshot, and approximately 57 GiB free disk. Eight shared containers are protected. Docker is `29.6.2`, Buildx is `0.35.0`, and runsc `release-20261005.0` is installed; installation alone does not demonstrate that the Orloom workload qualifies under it.

The host's system Node `20.20.2` is below this repository's Node `>=24` engine requirement. Prepare a private Node `24.15.0` runtime at `/opt/orloom-worker-runtime/node-v24.15.0`; verify the Node binary against SHA-256 `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`. Keep it local to Orloom. Do not change global Node, Docker configuration, the Docker daemon, host services, or network settings.

Hostinger qualification must use the existing fixed v10 suite unchanged: 1 CPU, 2 GiB memory, 128 PIDs, nonroot user, read-only filesystem, no network, and no host binds. Preserve the per-stage timeouts of 1800, 1830, 1845 and 1860 seconds, with a 2100-second ceiling. Build, verify, and run the suite sequentially under resource caps. Begin with one lane; the shared 2-CPU host provides no evidence for six-lane capacity.

## Disabled preparation template

[`deploy/hostinger/worker-preparation.env.example`](../../deploy/hostinger/worker-preparation.env.example) contains public defaults and blank secret/config pointers only. It deliberately leaves `ORLOOM_WORKER_MODE` and `ORLOOM_WORKER_APPROVED_TASK_FILE` blank, sets capacity to zero and capacity evidence to false, limits lanes to one, and disables integration and delivery. Do not fill blank database, provider, R2, image, policy, task, or control-plane values from guesses. The default worker startup exits before reading secrets or contacting services; with required activation configuration missing, a positive `--check-config` result is not expected and must not be claimed.

Do not install a systemd unit, create a new entrypoint, mount the staged key into an app, enable an existing app, or start a worker under this preparation. No Orloom image or engineering worker is currently recorded as loaded/running by this packet.

## Required successor gates

1. Freeze and independently review the documentation/configuration source successor. Its own acceptance gates do not inherit the accepted `4203f3a` source proof.
2. H3: produce Hostinger-specific, credential-free image/runsc identity and probe evidence, then pass the entire unchanged v10 suite. Record the exact source/image digests, resource controls, suite results, cleanup and host readback. H3 remains open until its own evidence and review exist.
3. H4: before any compatible app cutover, preserve and verify a backup, restore it in an isolated target, and record a rollback path. Establish that a compatible v10 reader is in place before writing v10 production records. Prepare and review the release with execution disabled. H4 remains open until its own release evidence and review exist.
4. H5: a real mission requires a separately owner-authorized bounded task after H3 and H4. Preserve the approved $1 cap; it remains unused. Any provider call, production certificate, draft PR and delivery requires its own exact evidence and authorization.

The owner retains activation, merge and delivery authority. Keep uncertain or interrupted effects `UNKNOWN`; do not infer readiness from healthy services, installed runtimes, a staged credential, local checks, or historical DigitalOcean qualification.
