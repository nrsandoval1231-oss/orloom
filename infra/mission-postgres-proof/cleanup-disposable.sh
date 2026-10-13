#!/usr/bin/env bash
set -euo pipefail

readonly NET=orloom-pg-proof-20261013-net
readonly DB=orloom-pg-proof-20261013-db
readonly TEST=orloom-pg-proof-20261013-test
readonly DATA=orloom-pg-proof-20261013-data
readonly SECRETS=orloom-pg-proof-20261013-secrets

for container in "$DB" "$TEST"; do
  if docker inspect "$container" >/dev/null 2>&1; then
    [[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$container") == ORL-PG-001 ]]
  fi
done
for volume in "$DATA" "$SECRETS"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    [[ $(docker volume inspect --format '{{index .Labels "orloom.packet"}}' "$volume") == ORL-PG-001 ]]
  fi
done
if docker network inspect "$NET" >/dev/null 2>&1; then
  [[ $(docker network inspect --format '{{index .Labels "orloom.packet"}}' "$NET") == ORL-PG-001 ]]
  attached=$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET" | tr ' ' '\n' | sort | xargs)
  [[ $attached == "$DB $TEST" ]]
fi

for container in "$TEST" "$DB"; do
  docker inspect "$container" >/dev/null 2>&1 && docker rm -f "$container" >/dev/null
done
for volume in "$SECRETS" "$DATA"; do
  docker volume inspect "$volume" >/dev/null 2>&1 && docker volume rm "$volume" >/dev/null
done
docker network inspect "$NET" >/dev/null 2>&1 && docker network rm "$NET" >/dev/null
for container in "$TEST" "$DB"; do
  ! docker inspect "$container" >/dev/null 2>&1
done
for volume in "$SECRETS" "$DATA"; do
  ! docker volume inspect "$volume" >/dev/null 2>&1
done
! docker network inspect "$NET" >/dev/null 2>&1
printf 'ORL-PG-001 disposable containers, volumes, and network removed\n'
