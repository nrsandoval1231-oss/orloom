#!/usr/bin/env bash
set -euo pipefail
dc(){ env -i PATH=/usr/bin:/bin /usr/bin/docker --config /run/orloom-verifier-lock --host unix:///var/run/docker.sock "$@"; }
[[ -z $(dc ps -aq --filter label=orloom.packet=ORL-C3-PROOF) && -z $(dc ps -aq --filter label=orloom.packet=ORL-C3) ]]
[[ -z $(dc network ls -q --filter label=orloom.packet=ORL-C3-PROOF) && -z $(dc volume ls -q --filter label=orloom.packet=ORL-C3-PROOF) ]]
for target in /var/lib/orloom/c3-proof-20261013/staging /var/lib/orloom/verifier/state /run/orloom-verifier-input/orloom-verifier-6f0f96cf-f4ab-4fc9-86c4-62a6bdb1f13d /run/orloom-verifier-docker.KSqn6I; do [[ ! -e $target && ! -L $target ]]; done
protected=$(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal)
[[ $protected == '5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running' ]]
jq -n --arg observedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg protected "$protected" '{observedAtUtc:$observedAtUtc,disposableContainers:0,disposableNetworks:0,disposableVolumes:0,stagingAbsent:true,slotAbsent:true,interruptedInputAbsent:true,staleDockerConfigAbsent:true,protectedContainer:$protected}'
