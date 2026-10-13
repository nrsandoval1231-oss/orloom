# ORL-ISO-001 evidence

All remote commands ran on SSH alias `codex-dark-peak-5042` (droplet 608538530); final exact-candidate tests/smoke completed 2026-10-13 01:53:49 UTC. Secret values and OAuth file contents were never read or recorded.

## Host and installation

- Ubuntu 24.04, x86_64, kernel 6.8.0-124-generic; Docker 29.6.0, Compose 5.1.4; 2 vCPU, about 4.0 GiB RAM and 33 GiB free disk at preflight.
- Official gVisor signed APT repository; installed `runsc` 20261005.0, package sha256 `2e7193c95424de28ac1a936fd5f0ec615dd288b74517bba697aa87c06df4a7c4`; `/usr/bin/runsc` sha256 `210b437a9cfae51e8f8c9074ed19b8b5e59477178e2e391a18117d8d6b924f7a`.
- `/etc/docker/daemon.json` was absent before installation. `runsc install --runtime=runsc --download-sidecars=NEVER --require-sidecars=ALWAYS` registered the path. Config validation passed. Docker was reloaded (systemd service supports reload); Docker PID did not change. `docker info` confirmed default `runc` and opt-in runtime `runsc`.
- Existing `codex-universal` ID remained `5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67`, StartedAt `2026-10-12T23:51:46.164222792Z`, restartCount 0, runtime `runc`. After smoke, `docker ps` contained only this container.
- Codex OAuth directory metadata only: `/var/lib/orloom/codex` remains mode 0700, owner `orloom:orloom`. Auth file contents/values were not read. `runuser -u orloom -- env CODEX_HOME=/var/lib/orloom/codex /opt/orloom/bin/codex login status` exited 0 and reported authenticated; output was suppressed. An initial attempt using `/usr/local/bin/codex` exited 126 because it points into root's home; the provision record's `/opt/orloom/bin/codex` invocation succeeded. No runtime/OAuth regression observed.

## Deterministic tests

- `python3 -m unittest discover -s /var/lib/orloom/worker-isolation/tests -v`: exit 0, 3 tests. Rejects extra mount/network/privileged/env options, option-like names, and inherited Docker/provider/account credential variables without echoing values.
- `./smoke-two-sandboxes.sh`: exit 0. Final exact-candidate run started two concurrent digest-pinned containers; Docker inspect assertions passed for `runsc`, no network, UID 65532, read-only rootfs, dropped ALL capabilities, no-new-privileges, PID 64, memory/swap 256 MiB, CPU 0.5, no bind/device/port mounts, and exactly two tmpfs entries. In-container checks passed for rootfs write denial, outbound TCP denial, independent `/tmp` and `/work`, and absence of Codex auth paths and Docker socket. Final samples were 14.32 MiB and 12.55 MiB; CPU samples 0.04% and 0.02%.
- Docker reports tmpfs in `HostConfig.Tmpfs` and returns an empty `Mounts` array. The assertion follows Docker's inspect representation and rejects any bind/device/port mounts.
- Both test containers were removed by the script's cleanup trap; the pre-existing `codex-universal` container was not changed.

## Proof limits / UNKNOWN

The probes establish the configured properties for two short-lived sandbox containers on this host. They do not establish build capacity, reliable sustained execution, production escape resistance, output ingestion safety, or six concurrent live lanes. No worker job, provider call, GitHub call, credential transfer, or production deployment was performed.
