#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock
readonly ROOT=/var/lib/orloom/c3-suite-proof-20261013 LABEL=ORL-C3-SUITE-PROOF
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
readonly NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
[[ $EUID -eq 0 && $# -eq 5 && $1 =~ ^[a-f0-9]{40}$ && $2 =~ ^[a-f0-9]{40}$ && $3 =~ ^[a-f0-9]{64}$ && $4 =~ ^[a-f0-9]{64}$ && $5 =~ ^[a-f0-9]{64}$ ]]
readonly BASE_SHA=$1 CANDIDATE_SHA=$2 SOURCE_MANIFEST_SHA=$3 HELPER_SHA=$4 ENTRY_SHA=$5
[[ -d $ROOT/source && ! -L $ROOT/source && -d $ROOT/fixtures/objects.git && ! -L $ROOT/fixtures/objects.git ]]
[[ -f $ROOT/staging/database-url && ! -L $ROOT/staging/database-url && $(stat -c '%a' "$ROOT/staging/database-url") == 400 ]]
[[ -f $ROOT/staging/node && ! -L $ROOT/staging/node && $(sha256sum "$ROOT/staging/node" | cut -d' ' -f1) == $NODE_SHA ]]
[[ -f $ROOT/fixtures/fixtures.json && ! -L $ROOT/fixtures/fixtures.json && -f $ROOT/capacity-evidence.json && ! -L $ROOT/capacity-evidence.json ]]
[[ -f $ROOT/incoming/runtime-proof.mjs && ! -L $ROOT/incoming/runtime-proof.mjs && $(sha256sum "$ROOT/incoming/runtime-proof.mjs" | cut -d' ' -f1) == "$HELPER_SHA" ]]
[[ -f $ROOT/incoming/runtime-proof-entry.mjs && ! -L $ROOT/incoming/runtime-proof-entry.mjs && $(sha256sum "$ROOT/incoming/runtime-proof-entry.mjs" | cut -d' ' -f1) == "$ENTRY_SHA" ]]
[[ -d $ROOT/incoming/runtime-files && ! -L $ROOT/incoming/runtime-files && -f $ROOT/incoming/runtime-files/runtime-files.sha256 && ! -L $ROOT/incoming/runtime-files/runtime-files.sha256 && -f $ROOT/incoming/runtime-files/runtime-files-identity.json && ! -L $ROOT/incoming/runtime-files/runtime-files-identity.json ]]
(
cd "$ROOT/incoming/runtime-files"
sha256sum --check runtime-files.sha256 >/dev/null
jq -e --arg candidate "$CANDIDATE_SHA" --arg manifest "$SOURCE_MANIFEST_SHA" '.format == "orloom-c3-runtime-files-v1" and .candidate == $candidate and .sourceManifestSha256 == $manifest' runtime-files-identity.json >/dev/null
)
gitc(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" "$@"; }
[[ $(gitc rev-parse HEAD) == "$CANDIDATE_SHA" && -z $(gitc status --porcelain=v1) ]]
[[ $(gitc rev-parse 'refs/heads/feat/trusted-verification-suite^{commit}') == "$CANDIDATE_SHA" ]]
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$SOURCE_MANIFEST_SHA" ]]
[[ -d $ROOT/source/dist && ! -L $ROOT/source/dist && -d $ROOT/source/node_modules && ! -L $ROOT/source/node_modules ]]
[[ -z $(find "$ROOT/source/dist" "$ROOT/source/node_modules" -type l -print -quit) && -z $(find "$ROOT/source/dist" "$ROOT/source/node_modules" ! -type f ! -type d -print -quit) ]]
diff -u <(awk '$2 ~ /^(dist|node_modules)\// {sub(/^[a-f0-9]{64}  /,"",$0); print $0}' "$ROOT/incoming/runtime-files/runtime-files.sha256" | LC_ALL=C sort) <(cd "$ROOT/source" && find dist node_modules -type f -print | LC_ALL=C sort)
while IFS= read -r row; do
  [[ $row =~ ^([a-f0-9]{64})\ \ ([A-Za-z0-9._/-]+)$ ]]
  expected=${BASH_REMATCH[1]}; relative=${BASH_REMATCH[2]}
  [[ $relative == package.json || $relative == dist/* || $relative == node_modules/* ]]
  if [[ $relative != package.json ]]; then [[ -f "$ROOT/source/$relative" && ! -L "$ROOT/source/$relative" && $(sha256sum "$ROOT/source/$relative" | cut -d' ' -f1) == "$expected" ]]; fi
done < "$ROOT/incoming/runtime-files/runtime-files.sha256"
[[ -f $ROOT/source/dist/packages/learning/src/lesson-policy.js && -f $ROOT/source/dist/packages/stuck-resolver/src/recovery.js && -f $ROOT/source/node_modules/pg/package.json ]]
[[ $(jq -r '.sourceCandidate' "$ROOT/fixtures/fixtures.json") == "$CANDIDATE_SHA" ]]
readonly OBJECT=$ROOT/fixtures/objects.git FIXTURES=$ROOT/fixtures/fixtures.json
readonly IMAGE=$(cat "$ROOT/verifier-image.id")
[[ $IMAGE =~ ^sha256:[a-f0-9]{64}$ ]]
config=$(mktemp -d /run/orloom-c3-suite-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$SOCKET" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
[[ $(dc inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.candidate"}}' "$IMAGE") == "$IMAGE|$LABEL|$CANDIDATE_SHA" ]]
[[ $(dc inspect --format '{{.State.Health.Status}} {{index .Config.Labels "orloom.packet"}}' orloom-c3-suite-proof-20261013-db) == "healthy $LABEL" ]]
state=/var/lib/orloom/verifier/state
if [[ -e $state || -L $state ]]; then [[ -f $state && ! -L $state && ! -s $state ]] || { echo 'verifier slot is occupied or quarantined; reconcile before suite proof' >&2; exit 75; }; fi
runid=$(cat /proc/sys/kernel/random/uuid); evidence="$ROOT/evidence/runtime-$runid"; install -d -m 0700 "$evidence"
install -m 0400 "$ROOT/incoming/runtime-proof.mjs" "$ROOT/runtime-proof.mjs"
install -m 0400 "$ROOT/incoming/runtime-proof-entry.mjs" "$ROOT/runtime-proof-entry.mjs"
set +e
(
cd "$ROOT/source"
env -i PATH=/usr/bin:/bin HOME=/root LANG=C ORLOOM_PROOF_CONTROL_ROOT="$ROOT/source" \
 ORLOOM_PROOF_DATABASE_URL_FILE="$ROOT/staging/database-url" ORLOOM_PROOF_OBJECT_STORE="$OBJECT" \
 ORLOOM_PROOF_BASE_SHA="$BASE_SHA" ORLOOM_PROOF_CANDIDATE_SHA="$CANDIDATE_SHA" \
 ORLOOM_PROOF_FIXTURES_FILE="$FIXTURES" ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256="$(sha256sum "$ROOT/capacity-evidence.json" | cut -d' ' -f1)" \
 ORLOOM_PROOF_EVIDENCE_DIR="$evidence" ORLOOM_PROOF_DOCKER_CONFIG="$config" ORLOOM_PROOF_RUNTIME_MODULE="$ROOT/runtime-proof.mjs" ORLOOM_VERIFIER_IMAGE="$IMAGE" ORLOOM_VERIFIER_ID=c3-suite-proof \
 ORLOOM_VERIFIER_ARTIFACT_ROOT="$ROOT/artifacts" ORLOOM_VERIFIER_LAUNCHER="$ROOT/source/infra/verifier-isolation/launch-verifier.sh" \
 "$ROOT/staging/node" "$ROOT/runtime-proof-entry.mjs"
) > "$evidence/runner-output.txt" 2> "$evidence/runner-error.txt"
status=$?
set -e
printf '%s\n' "$status" > "$evidence/exit-code.txt"; chmod 0400 "$evidence/runner-output.txt" "$evidence/runner-error.txt" "$evidence/exit-code.txt"
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
if (( status != 0 )); then echo "suite proof did not pass; preserve UNKNOWN/FAIL evidence at $evidence (exit=$status)" >&2; exit "$status"; fi
echo "suite_runtime_proof=PASS evidence=$evidence candidate=$CANDIDATE_SHA"
