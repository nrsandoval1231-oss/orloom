set -euo pipefail
export PATH=/home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/node-v24.22.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
test -x /home/nrsan/.local/state/orloom-validation/runtime-FjPEqq/node-v24.22.0-linux-x64/bin/node
node --version
source_root=/mnt/c/Users/nrsan/Documents/Codex/2026-10-15/task-4/orloom
mkdir -p /home/nrsan/.local/state/orloom-validation
snapshot_root=$(mktemp -d /home/nrsan/.local/state/orloom-validation/owner-readiness-capacity-base-XXXXXX)
printf '%s\n' "$snapshot_root" > "$source_root/docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/linux-snapshot-path.txt"
tar -C "$source_root" --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$snapshot_root" -xf -
cp -a "$source_root/dist" "$snapshot_root/dist"
ln -s "$source_root/node_modules" "$snapshot_root/node_modules"
cd "$snapshot_root"
git init -q
git add -- . ':!node_modules'
node docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/freeze-manifests.mjs --staged > "$source_root/docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/linux-snapshot-manifest-verification.json"
node --test --test-concurrency=1 dist/tests/verification-config.test.js dist/tests/verification-runner.test.js > "$source_root/docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/persistent-snapshot-smoke.txt" 2>&1
node --test --test-concurrency=1 dist/tests/*.test.js > "$source_root/docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/final-linux-suite.txt" 2>&1
node docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/freeze-manifests.mjs --staged > "$source_root/docs/evidence/validation/2026-10-15-owner-readiness-capacity-base/linux-post-suite-manifest-verification.json"
