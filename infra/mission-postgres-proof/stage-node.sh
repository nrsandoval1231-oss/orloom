#!/usr/bin/env bash
set -euo pipefail

readonly TEST=orloom-pg-proof-20261013-test
readonly STAGING=/var/lib/orloom/mission-postgres-proof/staging
readonly NODE=/root/.nvm/versions/node/v24.15.0/bin/node
readonly IMAGE=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly HASH=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c

[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$TEST") == ORL-PG-001 ]]
[[ $(docker inspect --format '{{.Image}}' "$TEST") == "$IMAGE" ]]
[[ $(docker inspect --format '{{.Config.User}}' "$TEST") == 65532:65532 ]]
install -d -m 0700 "$STAGING"
docker cp "$TEST:$NODE" "$STAGING/node"
chmod 0700 "$STAGING/node"
[[ $(sha256sum "$STAGING/node" | cut -d' ' -f1) == "$HASH" ]]
cat "$STAGING/node" | docker exec -i --user 65532:65532 "$TEST" /bin/sh -c \
  'rm -f /work/node && cat > /work/node && chmod 0500 /work/node'
[[ $(docker exec --user 65532:65532 "$TEST" /work/node --version) == v24.15.0 ]]
[[ $(docker exec --user 65532:65532 "$TEST" /bin/sh -c 'id -u') == 65532 ]]
[[ $(docker exec --user 65532:65532 "$TEST" sha256sum /work/node | cut -d' ' -f1) == "$HASH" ]]
rm -f "$STAGING/node"
printf 'node=v24.15.0 uid=65532 sha256=%s staging_file_removed=true\n' "$HASH"
