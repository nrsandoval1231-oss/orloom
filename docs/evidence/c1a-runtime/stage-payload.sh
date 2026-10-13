#!/usr/bin/env bash
set -euo pipefail
readonly LABEL=ORL-005C1A-PG-RUNTIME
readonly PREFIX=orloom-c1a-pg-proof-20261013
readonly DB=${PREFIX}-db TEST=${PREFIX}-test NET=${PREFIX}-net DATA=${PREFIX}-data SECRETS=${PREFIX}-secrets
readonly DB_ID=5bad5efd9fa38990585d319d17a40c0dafbd5569175831851a9265d055acabb7
readonly TEST_ID=4559a5efd42682f81b9365f036ebfc69411e19569dcc2a29c260a67e49e84698
readonly NET_ID=fdba65968353e6a78af722de4a7ac2499e9432f717b7e5f97f33e6e53893614a
readonly PG_IMAGE=sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly TEST_IMAGE=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly NODE=/root/.nvm/versions/node/v24.15.0/bin/node
readonly NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
readonly STAGING=/var/lib/orloom/c1a-pg-proof-20261013/staging
[[ $# -eq 1 && $1 == prepare ]]
[[ $(docker inspect --format '{{.Id}}' "$DB") == "$DB_ID" ]]
[[ $(docker inspect --format '{{.Id}}' "$TEST") == "$TEST_ID" ]]
[[ $(docker inspect --format '{{.Image}}' "$DB") == "$PG_IMAGE" ]]
[[ $(docker inspect --format '{{.Image}}' "$TEST") == "$TEST_IMAGE" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$DB") == "$LABEL" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$TEST") == "$LABEL" ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$DB") == healthy ]]
[[ $(docker inspect --format '{{.State.Status}}' "$TEST") == running ]]
[[ $(docker inspect --format '{{.HostConfig.Runtime}}' "$TEST") == runsc ]]
[[ $(docker inspect --format '{{.Config.User}}' "$TEST") == 65532:65532 ]]
[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$TEST") == true ]]
[[ $(docker network inspect --format '{{.Id}}' "$NET") == "$NET_ID" ]]
[[ $(docker network inspect --format '{{index .Labels "orloom.packet"}}' "$NET") == "$LABEL" ]]
[[ $(docker network inspect --format '{{.Internal}}' "$NET") == true ]]
[[ $(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET" | tr ' ' '\n' | sort | xargs) == "$DB $TEST" ]]
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$DB") == '{}' ]]
[[ $(docker inspect --format '{{json .HostConfig.Binds}}' "$DB") == null ]]
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$TEST") == '{}' ]]
[[ $(docker inspect --format '{{json .HostConfig.Binds}}' "$TEST") == null ]]
[[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$DATA") == "$LABEL" ]]
[[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$SECRETS") == "$LABEL" ]]
[[ $(docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == '5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running' ]]
if [[ ${1:-} == prepare ]]; then
  [[ ! -e "$STAGING" ]]
  install -d -m 0700 "$STAGING"
  docker cp "$TEST:$NODE" "$STAGING/node"
  chmod 0700 "$STAGING/node"
  [[ $(sha256sum "$STAGING/node" | cut -d' ' -f1) == "$NODE_SHA" ]]
  cat "$STAGING/node" | docker exec -i --user 65532:65532 "$TEST" /bin/sh -c 'cat > /work/node && chmod 0500 /work/node'
  [[ $(docker exec --user 65532:65532 "$TEST" /work/node --version) == v24.15.0 ]]
  [[ $(docker exec --user 65532:65532 "$TEST" sha256sum /work/node | cut -d' ' -f1) == "$NODE_SHA" ]]
  printf 'stage_prepared=true node=v24.15.0 uid=65532 node_sha256=%s staging=%s\n' "$NODE_SHA" "$STAGING"
fi
