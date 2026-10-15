set -euo pipefail
export PATH=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/node-v24.22.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGHOST=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgsocket
createdb orloom_readiness_capacity_base_final
cd /mnt/c/Users/nrsan/Documents/Codex/2026-10-15/task-4/orloom
ORLOOM_READINESS_TEST_DATABASE_URL='postgresql://nrsan@/orloom_readiness_capacity_base_final?host=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/pgsocket' node scripts/validate-owner-readiness-postgres.mjs > docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/postgres.txt 2>&1
