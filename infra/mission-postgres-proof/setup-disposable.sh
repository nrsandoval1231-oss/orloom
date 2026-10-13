#!/usr/bin/env bash
set -euo pipefail

readonly NET=orloom-pg-proof-20261013-net
readonly DB=orloom-pg-proof-20261013-db
readonly TEST=orloom-pg-proof-20261013-test
readonly DATA=orloom-pg-proof-20261013-data
readonly SECRETS=orloom-pg-proof-20261013-secrets
readonly PG_IMAGE=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly TEST_IMAGE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304

[[ $(docker ps -a --filter "name=^${DB}$" -q | wc -l) -eq 0 ]]
[[ $(docker ps -a --filter "name=^${TEST}$" -q | wc -l) -eq 0 ]]
[[ $(docker network ls --filter "name=^${NET}$" -q | wc -l) -eq 0 ]]
[[ $(docker volume ls --filter "name=^${DATA}$" -q | wc -l) -eq 0 ]]
[[ $(docker volume ls --filter "name=^${SECRETS}$" -q | wc -l) -eq 0 ]]

docker network create --internal --driver bridge --label orloom.packet=ORL-PG-001 "$NET" >/dev/null
docker volume create --label orloom.packet=ORL-PG-001 "$DATA" >/dev/null
# Docker-managed private volume, temporary for this proof and removed at cleanup.
docker volume create --label orloom.packet=ORL-PG-001 "$SECRETS" >/dev/null

# Create two owner-restricted copies in a temporary Docker-managed volume. Neither secret is
# present in a command argument, environment value, config, log, or output.
docker run --rm --pull=never --name orloom-pg-proof-20261013-secret-init --label orloom.packet=ORL-PG-001 \
  --network none --read-only --cpus=0.25 --memory=128m --memory-swap=128m --pids-limit=32 \
  --mount "type=volume,src=$SECRETS,dst=/run/secrets" \
  --entrypoint=/bin/sh "$PG_IMAGE" -ec '
    umask 077
    chmod 0755 /run/secrets
    od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/pg-password-db
    cp /run/secrets/pg-password-db /run/secrets/pg-password-test
    chown postgres:postgres /run/secrets/pg-password-db
    chown 65532:65532 /run/secrets/pg-password-test
    chmod 0400 /run/secrets/pg-password-db /run/secrets/pg-password-test
    test "$(wc -c < /run/secrets/pg-password-db)" -eq 64
    test "$(wc -c < /run/secrets/pg-password-test)" -eq 64
  ' >/dev/null

docker run --detach --pull=never --name "$DB" --label orloom.packet=ORL-PG-001 --network "$NET" --network-alias pg \
  --restart=no --cpus=0.50 --memory=512m --memory-swap=512m --pids-limit=64 --read-only \
  --log-driver=json-file --log-opt max-size=10m --log-opt max-file=2 \
  --mount "type=volume,src=$DATA,dst=/var/lib/postgresql/data" \
  --mount "type=volume,src=$SECRETS,dst=/run/secrets,readonly" \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=70,gid=70,mode=3775 \
  --health-cmd='pg_isready -U mission_proof -d mission_proof' \
  --health-interval=2s --health-timeout=2s --health-retries=30 \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/pg-password-db \
  -e POSTGRES_USER=mission_proof -e POSTGRES_DB=mission_proof "$PG_IMAGE" >/dev/null

docker run --detach --pull=never --name "$TEST" --label orloom.packet=ORL-PG-001 --network "$NET" --restart=no --runtime=runsc \
  --cpus=1.0 --memory=768m --memory-swap=768m --pids-limit=128 --read-only \
  --user=65532:65532 --cap-drop=ALL --security-opt=no-new-privileges:true \
  --log-driver=json-file --log-opt max-size=10m --log-opt max-file=2 \
  --mount "type=volume,src=$SECRETS,dst=/run/secrets,readonly" \
  --tmpfs /work:rw,exec,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700 \
  --entrypoint=/bin/sh "$TEST_IMAGE" -ec 'while :; do sleep 3600; done' >/dev/null

health=starting
for _ in $(seq 1 30); do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$DB")
  [[ $health == healthy ]] && break
  [[ $health != unhealthy ]] || { printf 'database readiness failed\n' >&2; exit 1; }
  sleep 2
done
[[ $health == healthy ]] || { printf 'database readiness timed out\n' >&2; exit 1; }

printf 'setup=ready postgres_health=%s postgres_digest=%s test_digest=%s\n' \
  "$health" "$PG_IMAGE" "$TEST_IMAGE"
docker inspect --format 'db={{.Name}} status={{.State.Status}} runtime={{.HostConfig.Runtime}} user={{.Config.User}} network={{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}} ports={{json .HostConfig.PortBindings}} binds={{json .HostConfig.Binds}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}' "$DB"
docker inspect --format 'test={{.Name}} status={{.State.Status}} runtime={{.HostConfig.Runtime}} user={{.Config.User}} network={{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}} ports={{json .HostConfig.PortBindings}} binds={{json .HostConfig.Binds}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}' "$TEST"
