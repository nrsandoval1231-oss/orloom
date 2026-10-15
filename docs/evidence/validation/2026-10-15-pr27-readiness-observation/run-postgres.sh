set -euo pipefail
export PATH=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/node-v24.22.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
/usr/lib/postgresql/18/bin/pg_ctl -D /home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgdata -l /home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/postgres.txt -o "-k /home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgsocket -h ''" start
trap '/usr/lib/postgresql/18/bin/pg_ctl -D /home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgdata stop -m fast' EXIT
export PGHOST=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgsocket
createdb orloom_pr27_readiness_observation_final
cd /mnt/c/Users/nrsan/Documents/Codex/2026-10-15/task-4/orloom
ORLOOM_READINESS_TEST_DATABASE_URL='postgresql://nrsan@/orloom_pr27_readiness_observation_final?host=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgsocket' node scripts/validate-owner-readiness-postgres.mjs > docs/evidence/validation/2026-10-15-pr27-readiness-observation/postgres.txt 2>&1
