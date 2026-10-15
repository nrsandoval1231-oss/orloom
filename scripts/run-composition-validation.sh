#!/usr/bin/env bash
set -uo pipefail
validation_root=$(cat .orloom-validation-root)
node_path="$validation_root/node-v24.22.0-linux-x64/bin/node"
export PATH="$validation_root/node-v24.22.0-linux-x64/bin:$PATH"
evidence=docs/validation/2026-10-15-composition
proof_database="orloom_proof_$(date +%s%N)"
createdb -h "$validation_root/pgsocket" "$proof_database" || exit 1
export ORLOOM_COMPOSITION_TEST_DATABASE_URL="postgresql:///$proof_database?host=$validation_root/pgsocket"
"$node_path" scripts/validate-composition-postgres.mjs > "$evidence/postgres.txt" 2>&1
postgres_status=$?
"$node_path" --test --test-concurrency=1 dist/tests/*.test.js > "$evidence/linux-suite.txt" 2>&1
suite_status=$?
printf 'postgres_exit=%s suite_exit=%s\n' "$postgres_status" "$suite_status"
tail -15 "$evidence/postgres.txt"
tail -15 "$evidence/linux-suite.txt"
if [ "$postgres_status" -ne 0 ] || [ "$suite_status" -ne 0 ]; then exit 1; fi
