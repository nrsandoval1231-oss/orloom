#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker S=unix:///var/run/docker.sock L=ORL-C3-PROOF PREFIX=orloom-c3-proof-20261013
readonly ROOT=/var/lib/orloom/c3-proof-20261013 STAGING=/var/lib/orloom/c3-proof-20261013/staging
readonly CID=140edd29f054bc9897d8f66a8b6b3bc90054954b8ff19996a31dd3fc6198dce4
readonly RUN=orloom-verifier-6f0f96cf-f4ab-4fc9-86c4-62a6bdb1f13d
readonly CANDIDATE=765943eae18c09aa882e52c7f5255dd776c5fd43 MANIFEST=91c672bd6519df3ef6344878cb75ddd81eb9285c9ad15f5528c85710ad89a211
readonly EXPECTED_PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
readonly HELPER_SHA=bf37dd990f286f334a817a4493d8c67ba8beba62cbc1141e1505200df3706b13
[[ $EUID -eq 0 && $# -eq 0 && -d $ROOT && ! -L $ROOT && -d $STAGING && ! -L $STAGING ]]
[[ -d "$ROOT/source/.git" && ! -L "$ROOT/source/.git" ]]
[[ $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" rev-parse HEAD) == "$CANDIDATE" ]]
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-MANIFEST.sha256" | cut -d' ' -f1) == "$MANIFEST" ]]
readonly URLFILE="$STAGING/database-url" INCOMING="$ROOT/incoming/continue-runtime-proof.mjs"
[[ -f $URLFILE && ! -L $URLFILE && $(stat -c '%a' "$URLFILE") == 400 && -f $INCOMING && ! -L $INCOMING ]]
[[ $(sha256sum "$INCOMING" | cut -d' ' -f1) == "$HELPER_SHA" ]]
readonly PAYLOAD="$STAGING/payload" TARGET="$STAGING/payload/c3-runtime-proof/continue-runtime-proof.mjs"
[[ -d $PAYLOAD && ! -L $PAYLOAD && -d "$STAGING/payload/c3-runtime-proof" && ! -L "$STAGING/payload/c3-runtime-proof" && -f "$STAGING/payload-manifest.sha256" && ! -L "$STAGING/payload-manifest.sha256" ]]
(cd "$STAGING/payload" && sha256sum --check "$STAGING/payload-manifest.sha256" >/dev/null)
[[ -f "$STAGING/node" && ! -L "$STAGING/node" && $(sha256sum "$STAGING/node" | cut -d' ' -f1) == d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c ]]
[[ ! -e $TARGET && ! -L $TARGET ]]
install -m 0400 -- "$INCOMING" "$TARGET"
[[ $(sha256sum "$TARGET" | cut -d' ' -f1) == "$HELPER_SHA" ]]
readonly IMAGE=$(cat "$ROOT/verifier-image.id")
[[ $IMAGE =~ ^sha256:[a-f0-9]{64}$ ]]
readonly STATE=/var/lib/orloom/verifier/state
[[ -f $STATE && ! -L $STATE && $(cat "$STATE") == "ORL-C3|$RUN|$IMAGE|$CID|running" ]]
config=$(mktemp -d /run/orloom-c3-continue-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$EXPECTED_PROTECTED" ]]
container=$(dc inspect --format '{{.Id}}|{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.run"}}|{{.State.Status}}' "$CID")
[[ $container == "$CID|$IMAGE|$IMAGE|ORL-C3|$RUN|created" ]]
readonly DB=orloom-c3-proof-20261013-db NET=orloom-c3-proof-20261013-net
[[ $(dc inspect --format '{{index .Config.Labels "orloom.packet"}} {{.State.Health.Status}}' "$DB") == "$L healthy" ]]
[[ $(dc network inspect --format '{{index .Labels "orloom.packet"}} {{.Internal}}' "$NET") == "$L true" ]]
readonly OBJECT="$STAGING/source.git" CAPACITY="$ROOT/capacity-evidence.json" LAUNCHER="$ROOT/source/infra/verifier-isolation/launch-verifier.sh"
[[ -d $OBJECT && ! -L $OBJECT && -f $CAPACITY && ! -L $CAPACITY && -f $LAUNCHER && ! -L $LAUNCHER ]]
repo_map=$(printf '{"nrsandoval1231-oss/orloom":{"objectStore":"%s","approvedRef":"refs/heads/candidate"}}' "$OBJECT")
runid=$(cat /proc/sys/kernel/random/uuid); evidence="$ROOT/evidence/continuation-${runid//-/}"; install -d -m 0700 "$evidence"
readonly STALE=/run/orloom-verifier-docker.KSqn6I
[[ -d $STALE && ! -L $STALE ]]
set +e
(cd "$STAGING/payload/orloom-ci" && env -i PATH=/usr/bin:/bin HOME=/root LANG=C \
 ORLOOM_PROOF_DATABASE_URL_FILE="$URLFILE" ORLOOM_PROOF_OBJECT_STORE="$OBJECT" \
 ORLOOM_PROOF_BASE_SHA="$(jq -er '.baseSha | select(test("^[a-f0-9]{40}$"))' "$STAGING/payload-identity.json")" \
 ORLOOM_PROOF_CANDIDATE_SHA="$CANDIDATE" ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256="$(sha256sum "$CAPACITY" | cut -d' ' -f1)" \
 ORLOOM_PROOF_DOCKER_CONFIG="$config" ORLOOM_PROOF_STALE_CONFIG="$STALE" \
 ORLOOM_VERIFIER_IMAGE="$IMAGE" ORLOOM_VERIFIER_ID=c3-runsc-verifier ORLOOM_VERIFIER_ARTIFACT_ROOT="$ROOT/artifacts" \
 ORLOOM_PROOF_EVIDENCE_DIR="$evidence" ORLOOM_VERIFIER_REPOSITORIES="$repo_map" ORLOOM_VERIFIER_LAUNCHER="$LAUNCHER" \
 "$STAGING/node" ../c3-runtime-proof/continue-runtime-proof.mjs > "$evidence/runner-output.txt" 2> "$evidence/runner-error.txt")
status=$?; set -e; printf '%s\n' "$status" > "$evidence/exit-code.txt"
if (( status != 0 )); then echo "continuation failed closed; inspect dedicated evidence directory (exit=$status)" >&2; exit "$status"; fi
grep -q '"status":"PASS"' "$evidence/runner-output.txt"
(cd "$evidence" && find . -type f ! -name evidence-files.sha256 -print0 | sort -z | xargs -0 sha256sum) > "$evidence/evidence-files.sha256"
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$EXPECTED_PROTECTED" ]]
(cd "$evidence" && find . -type f ! -name evidence-files.sha256 -print0 | sort -z | xargs -0 sha256sum) > "$evidence/evidence-files.sha256"
echo "continuation=PASS candidate=$CANDIDATE evidence=$evidence original_attempt=UNKNOWN"

