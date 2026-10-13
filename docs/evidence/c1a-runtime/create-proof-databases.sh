#!/usr/bin/env bash
set -euo pipefail
readonly DB=orloom-c1a-pg-proof-20261013-db
readonly DB_ID=5bad5efd9fa38990585d319d17a40c0dafbd5569175831851a9265d055acabb7
readonly LABEL=ORL-005C1A-PG-RUNTIME
[[ $# -eq 0 ]]
[[ $(docker inspect --format '{{.Id}}' "$DB") == "$DB_ID" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$DB") == "$LABEL" ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$DB") == healthy ]]
[[ $(docker inspect --format '{{.HostConfig.PortBindings}}' "$DB") == 'map[]' ]]
for name in mission_proof_03 mission_proof_aux_03; do
  [[ $(docker exec "$DB" psql -U mission_admin -d mission_proof -Atc "SELECT count(*) FROM pg_database WHERE datname='$name'") == 0 ]]
done
docker exec "$DB" psql -U mission_admin -d mission_proof -v ON_ERROR_STOP=1 -c 'CREATE DATABASE mission_proof_03 OWNER mission_app' >/dev/null
docker exec "$DB" psql -U mission_admin -d mission_proof -v ON_ERROR_STOP=1 -c 'CREATE DATABASE mission_proof_aux_03 OWNER mission_app' >/dev/null
[[ $(docker exec "$DB" psql -U mission_admin -d mission_proof -Atc "SELECT string_agg(datname || ':' || pg_get_userbyid(datdba), ',' ORDER BY datname) FROM pg_database WHERE datname IN ('mission_proof_03','mission_proof_aux_03')") == 'mission_proof_03:mission_app,mission_proof_aux_03:mission_app' ]]
[[ $(docker exec "$DB" psql -U mission_admin -d mission_proof -Atc "SELECT rolsuper FROM pg_roles WHERE rolname='mission_app'") == f ]]
printf 'fresh_databases=created owners=mission_app role_superuser=false preserved_attempts=01,02\n'
