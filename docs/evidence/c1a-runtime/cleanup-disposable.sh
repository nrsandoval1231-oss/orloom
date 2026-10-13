#!/usr/bin/env bash
set -euo pipefail
trap 'echo cleanup_failure_line=${LINENO}' ERR
readonly LABEL=ORL-005C1A-PG-RUNTIME
readonly PREFIX=orloom-c1a-pg-proof-20261013
readonly DB=${PREFIX}-db TEST=${PREFIX}-test NET=${PREFIX}-net DATA=${PREFIX}-data SECRETS=${PREFIX}-secrets
readonly DB_ID=5bad5efd9fa38990585d319d17a40c0dafbd5569175831851a9265d055acabb7
readonly TEST_ID=4559a5efd42682f81b9365f036ebfc69411e19569dcc2a29c260a67e49e84698
readonly NET_ID=fdba65968353e6a78af722de4a7ac2499e9432f717b7e5f97f33e6e53893614a
readonly PAYLOAD_SHA=77322aa943bc1df89931f96f917bfb020eb98385e3b590b543d50e22f3cc4ec3
readonly STAGING=/var/lib/orloom/c1a-pg-proof-20261013/staging
[[ $# -eq 0 ]]
[[ $(docker inspect --format '{{.Id}}' "$DB") == "$DB_ID" ]]
[[ $(docker inspect --format '{{.Id}}' "$TEST") == "$TEST_ID" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$DB") == "$LABEL" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$TEST") == "$LABEL" ]]
[[ $(docker network inspect --format '{{.Id}}' "$NET") == "$NET_ID" ]]
[[ $(docker network inspect --format '{{index .Labels "orloom.packet"}}' "$NET") == "$LABEL" ]]
[[ $(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET" | tr ' ' '\n' | sort | xargs) == "$DB $TEST" ]]
[[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$DATA") == "$LABEL" ]]
[[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$SECRETS") == "$LABEL" ]]
[[ $(docker ps -a --no-trunc --filter "volume=$DATA" --format '{{.Names}}' | sort | xargs) == "$DB" ]]
[[ $(docker ps -a --no-trunc --filter "volume=$SECRETS" --format '{{.Names}}' | sort | xargs) == "$DB $TEST" ]]
[[ $(sha256sum "$STAGING/payload-manifest-04.sha256" | cut -d' ' -f1) == "$PAYLOAD_SHA" ]]
grep -q '^C1A_REAL_POSTGRES_HTTP_PROOF=PASS ' "$STAGING/runtime-result-03.txt"
[[ $(cat "$STAGING/identity-03.marker") == "$PAYLOAD_SHA  payload-manifest-04.sha256" ]]
[[ $(docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == '5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running' ]]
[[ "$STAGING" == /var/lib/orloom/c1a-pg-proof-20261013/staging ]]
[[ ! -L "$STAGING" ]]
[[ $(cat "$STAGING/identity.marker") == 'c762b23e663afe781cdd58f5253a632ae9d12f64aca13ed797c0b9062f7c81de  payload-manifest.sha256' ]]
if [[ ${CLEANUP_PREFLIGHT_ONLY:-0} == 1 ]]; then printf 'cleanup_preflight=PASS guards_only\n'; exit 0; fi
for container in "$TEST" "$DB"; do docker rm -f "$container" >/dev/null; done
for volume in "$SECRETS" "$DATA"; do docker volume rm "$volume" >/dev/null; done
docker network rm "$NET" >/dev/null
rm -rf -- "$STAGING"
rmdir /var/lib/orloom/c1a-pg-proof-20261013
! docker inspect "$DB" >/dev/null 2>&1
! docker inspect "$TEST" >/dev/null 2>&1
! docker network inspect "$NET" >/dev/null 2>&1
! docker volume inspect "$DATA" >/dev/null 2>&1
! docker volume inspect "$SECRETS" >/dev/null 2>&1
printf 'cleanup=PASS exact labeled containers, volumes, network, staging removed; protected codex-universal unchanged\n'
if [[ ${CLEANUP_PREFLIGHT_ONLY:-0} == 1 ]]; then echo cleanup_preflight=PASS; exit 0; fi