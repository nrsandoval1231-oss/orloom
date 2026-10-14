#!/usr/bin/env bash
set -euo pipefail

readonly LABEL=ORL-005C1A-PG-RUNTIME
readonly PREFIX=orloom-c1a-pg-proof-20261013
readonly NET=${PREFIX}-net DB=${PREFIX}-db TEST=${PREFIX}-test
readonly DATA=${PREFIX}-data SECRETS=${PREFIX}-secrets
readonly INIT=${PREFIX}-secret-init
readonly PG_REF=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly TEST_REF=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304

for name in "$INIT" "$DB" "$TEST"; do [[ -z $(docker ps -a --filter "name=^${name}$" -q) ]]; done
[[ -z $(docker network ls --filter "name=^${NET}$" -q) ]]
[[ -z $(docker volume ls --filter "name=^${DATA}$" -q) ]]
[[ -z $(docker volume ls --filter "name=^${SECRETS}$" -q) ]]

docker network create --internal --driver bridge --label "orloom.packet=$LABEL" "$NET" >/dev/null
docker volume create --label "orloom.packet=$LABEL" "$DATA" >/dev/null
docker volume create --label "orloom.packet=$LABEL" "$SECRETS" >/dev/null
docker run --rm --pull=never --name "$INIT" --label "orloom.packet=$LABEL" --network none --read-only \
  --cpus=0.25 --memory=128m --memory-swap=128m --pids-limit=32 \
  --mount "type=volume,src=$SECRETS,dst=/run/secrets" --entrypoint=/bin/sh "$PG_REF" -ec '
    umask 077; chmod 0755 /run/secrets
    od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/pg-password-admin
    od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/pg-password-test
    chown postgres:postgres /run/secrets/pg-password-admin /run/secrets/pg-password-test
    chown 65532:65532 /run/secrets/pg-password-test
    chmod 0400 /run/secrets/pg-password-admin /run/secrets/pg-password-test
    test "$(wc -c < /run/secrets/pg-password-admin)" -eq 64
    test "$(wc -c < /run/secrets/pg-password-test)" -eq 64
    app_password=$(cat /run/secrets/pg-password-test)
    { printf "CREATE ROLE mission_app LOGIN PASSWORD "; printf "\\044orloom\\044%s\\044orloom\\044;\n" "$app_password"; printf "ALTER DATABASE mission_proof OWNER TO mission_app;\nCREATE DATABASE mission_proof_aux OWNER mission_app;\n"; } > /run/secrets/001-create-app.sql
    chown postgres:postgres /run/secrets/001-create-app.sql
    chmod 0400 /run/secrets/001-create-app.sql
    unset app_password
  ' >/dev/null

docker run --detach --pull=never --name "$DB" --label "orloom.packet=$LABEL" --network "$NET" --network-alias pg \
  --restart=no --cpus=0.50 --memory=512m --memory-swap=512m --pids-limit=64 --read-only \
  --log-driver=json-file --log-opt max-size=10m --log-opt max-file=2 \
  --mount "type=volume,src=$DATA,dst=/var/lib/postgresql/data" --mount "type=volume,src=$SECRETS,dst=/run/secrets,readonly" --mount "type=volume,src=$SECRETS,dst=/docker-entrypoint-initdb.d,readonly" \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=70,gid=70,mode=3775 \
  --health-cmd='pg_isready -U mission_admin -d mission_proof' --health-interval=2s --health-timeout=2s --health-retries=30 \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/pg-password-admin -e POSTGRES_USER=mission_admin -e POSTGRES_DB=mission_proof "$PG_REF" >/dev/null
docker run --detach --pull=never --name "$TEST" --label "orloom.packet=$LABEL" --network "$NET" --restart=no --runtime=runsc \
  --cpus=1.0 --memory=768m --memory-swap=768m --pids-limit=128 --read-only --user=65532:65532 --cap-drop=ALL --security-opt=no-new-privileges:true \
  --log-driver=json-file --log-opt max-size=10m --log-opt max-file=2 \
  --mount "type=volume,src=$SECRETS,dst=/run/secrets,readonly" \
  --tmpfs /work:rw,exec,nosuid,nodev,size=384m,uid=65532,gid=65532,mode=0700 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700 \
  --entrypoint=/bin/sh "$TEST_REF" -ec 'while :; do sleep 3600; done' >/dev/null

health=starting
for _ in $(seq 1 30); do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$DB")
  [[ $health == healthy ]] && break
  [[ $health != unhealthy ]] || { printf 'database readiness failed\n' >&2; exit 1; }
  sleep 2
done
[[ $health == healthy ]]
printf 'setup=ready label=%s database_health=%s image_ids=' "$LABEL" "$health"
docker image inspect --format '{{.Id}}' "$PG_REF" | tr '\n' ' '
docker image inspect --format '{{.Id}}' "$TEST_REF"
docker inspect --format 'db={{.Id}} status={{.State.Status}} health={{.State.Health.Status}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} ports={{json .HostConfig.PortBindings}} binds={{json .HostConfig.Binds}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}' "$DB"
docker inspect --format 'test={{.Id}} status={{.State.Status}} runtime={{.HostConfig.Runtime}} user={{.Config.User}} ports={{json .HostConfig.PortBindings}} binds={{json .HostConfig.Binds}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}' "$TEST"
