#!/usr/bin/env bash
set -euo pipefail
trap 'printf "rerun_guard_line=%s\n" "$LINENO" >&2' ERR

readonly NET=orloom-pg-proof-20261013-net
readonly DB=orloom-pg-proof-20261013-db
readonly TEST=orloom-pg-proof-20261013-test
readonly DATA=orloom-pg-proof-20261013-data
readonly SECRETS=orloom-pg-proof-20261013-secrets
readonly NET_ID=399cf0af6a3e668651a15570d5411d5f3a2ff18efc60c88c4c4036670bd8289d
readonly DB_ID=9b1618fb6920a38218f3b18a7a10e2d2c7f32cc0856804813936b25a500457e7
readonly TEST_ID=8b6797376f2768d7f272ec3af0ba5bdb6f52fd939b645687eda122dc77cac5f8
readonly PG_IMAGE=sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly TEST_IMAGE=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly SOURCE_MANIFEST=c418a11e1e616eda7d1005c45a317082013d2c9923883f9dd58ed92bf414b287
readonly BUNDLE_MANIFEST=5840ff1f91c4c4c9b2757a24e2956ffb9fadc693662d59e6b86a8ad0ffb6de97
readonly RESET_HASH=0e0c12bba0623925e2b6afddccbc921e39c0bd1c9efb996e671dd9137dfdf648
readonly STAGING=/var/lib/orloom/mission-postgres-proof/staging

[[ $(docker inspect --format '{{.Id}}' "$DB") == "$DB_ID" ]]
[[ $(docker inspect --format '{{.Id}}' "$TEST") == "$TEST_ID" ]]
[[ $(docker inspect --format '{{.Image}}' "$DB") == "$PG_IMAGE" ]]
[[ $(docker inspect --format '{{.Image}}' "$TEST") == "$TEST_IMAGE" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$DB") == ORL-PG-001 ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$TEST") == ORL-PG-001 ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$DB") == healthy ]]
[[ $(docker inspect --format '{{.State.Status}}' "$TEST") == running ]]
[[ $(docker inspect --format '{{.HostConfig.Runtime}}' "$TEST") == runsc ]]
[[ $(docker inspect --format '{{.Config.User}}' "$TEST") == 65532:65532 ]]
[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$TEST") == true ]]
[[ $(docker inspect --format '{{.HostConfig.PidsLimit}}' "$TEST") == 128 ]]
[[ $(docker inspect --format '{{json .HostConfig.CapDrop}}' "$TEST") == '["ALL"]' ]]
[[ $(docker network inspect --format '{{.Id}}' "$NET") == "$NET_ID" ]]
[[ $(docker network inspect --format '{{index .Labels "orloom.packet"}}' "$NET") == ORL-PG-001 ]]
[[ $(docker network inspect --format '{{.Internal}}' "$NET") == true ]]
[[ $(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET" | tr ' ' '\n' | sort | xargs) == "$DB $TEST" ]]
[[ $(docker inspect --format '{{(index .NetworkSettings.Networks "orloom-pg-proof-20261013-net").IPAddress}}' "$DB") == 172.19.0.2 ]]
[[ $(docker inspect --format '{{(index .NetworkSettings.Networks "orloom-pg-proof-20261013-net").IPAddress}}' "$TEST") == 172.19.0.3 ]]
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$DB") == '{}' ]]
[[ $(docker inspect --format '{{json .HostConfig.Binds}}' "$DB") == null ]]
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$TEST") == '{}' ]]
[[ $(docker inspect --format '{{json .HostConfig.Binds}}' "$TEST") == null ]]
[[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$DATA") == ORL-PG-001 ]]
[[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$SECRETS") == ORL-PG-001 ]]
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets"}}{{.Name}} {{.RW}}{{end}}{{end}}' "$DB") == "$SECRETS false" ]]
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets"}}{{.Name}} {{.RW}}{{end}}{{end}}' "$TEST") == "$SECRETS false" ]]
env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$DB")
printf '%s\n' "$env" | grep -qx 'POSTGRES_USER=mission_proof'
printf '%s\n' "$env" | grep -qx 'POSTGRES_DB=mission_proof'
printf '%s\n' "$env" | grep -qx 'POSTGRES_PASSWORD_FILE=/run/secrets/pg-password-db'
! printf '%s\n' "$env" | grep -q '^POSTGRES_PASSWORD='
unset env

[[ $(sha256sum "$STAGING/bundle-manifest.sha256" | cut -d' ' -f1) == "$BUNDLE_MANIFEST" ]]
[[ $(sha256sum "$STAGING/candidate-manifest.sha256" | cut -d' ' -f1) == "$SOURCE_MANIFEST" ]]
[[ $(sha256sum "$STAGING/reset-proof-db.mjs" | cut -d' ' -f1) == "$RESET_HASH" ]]
(cd "$STAGING/payload-final/app" && sha256sum --check "$STAGING/bundle-manifest.sha256" >/dev/null)
if [[ ${1:-} == --check-only ]]; then
  printf 'safe_preconditions=pass source_manifest=%s bundle_manifest=%s\n' "$SOURCE_MANIFEST" "$BUNDLE_MANIFEST"
  exit 0
fi
[[ $# -eq 0 ]]
cat "$STAGING/bundle-manifest.sha256" | docker exec -i --user=65532:65532 "$TEST" /bin/sh -c 'cat > /work/app.sha256'
[[ $(docker exec --user=65532:65532 "$TEST" sha256sum /work/app.sha256 | cut -d' ' -f1) == "$BUNDLE_MANIFEST" ]]
docker exec --user=65532:65532 --workdir=/work/app "$TEST" sha256sum --check /work/app.sha256 >/dev/null
cat "$STAGING/reset-proof-db.mjs" | docker exec -i --user=65532:65532 "$TEST" /bin/sh -c 'cat > /work/app/reset-proof-db.mjs'
printf 'source_manifest=%s bundle_manifest=%s\n' "$SOURCE_MANIFEST" "$BUNDLE_MANIFEST"
docker exec --user=65532:65532 --workdir=/work/app --env=ORLOOM_PG_HOST=172.19.0.2 "$TEST" /work/node ./reset-proof-db.mjs
docker exec --user=65532:65532 --workdir=/work/app --env=ORLOOM_PG_HOST=172.19.0.2 "$TEST" /work/node ./postgres-proof.mjs
