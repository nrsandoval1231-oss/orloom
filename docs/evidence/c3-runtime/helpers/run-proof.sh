#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker S=unix:///var/run/docker.sock L=ORL-C3-PROOF PREFIX=orloom-c3-proof-20261013
readonly ROOT=/var/lib/orloom/c3-proof-20261013 STAGING=/var/lib/orloom/c3-proof-20261013/staging DB=$PREFIX-db NET=$PREFIX-net SECRET=$PREFIX-secrets
readonly EXPECTED_PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
readonly EXPECTED_CANDIDATE=765943eae18c09aa882e52c7f5255dd776c5fd43 EXPECTED_SOURCE_MANIFEST=91c672bd6519df3ef6344878cb75ddd81eb9285c9ad15f5528c85710ad89a211
[[ $EUID -eq 0 && $# -eq 3 && $1 == prepare && $2 =~ ^[a-f0-9]{40}$ && $3 =~ ^[a-f0-9]{64}$ && -d $STAGING && ! -L $STAGING ]]
[[ $2 == "$EXPECTED_CANDIDATE" && $3 == "$EXPECTED_SOURCE_MANIFEST" ]]
[[ -d "$ROOT/source" && ! -L "$ROOT/source" && -d "$ROOT/source/.git" && ! -L "$ROOT/source/.git" ]]
[[ $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" rev-parse HEAD) == "$EXPECTED_CANDIDATE" ]]
readonly EXPECTED_SHA=$2 EXPECTED_MANIFEST=$3
config=$(mktemp -d /run/orloom-c3-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$EXPECTED_PROTECTED" ]]
identity="$STAGING/payload-identity.json"
[[ -f $identity && ! -L $identity && -f "$STAGING/payload-manifest.sha256" && ! -L "$STAGING/payload-manifest.sha256" && -f "$STAGING/node" && ! -L "$STAGING/node" && -f "$ROOT/capacity-evidence.json" && ! -L "$ROOT/capacity-evidence.json" ]]
candidate=$(jq -er '.candidateSha | select(test("^[a-f0-9]{40}$"))' "$identity"); base=$(jq -er '.baseSha | select(test("^[a-f0-9]{40}$"))' "$identity")
[[ $candidate == "$EXPECTED_SHA" && $(jq -r .sourceManifestSha256 "$identity") == "$EXPECTED_SOURCE_MANIFEST" ]]
[[ $(dc inspect --format '{{index .Config.Labels "orloom.packet"}}' "$DB") == "$L" && $(dc inspect --format '{{.State.Health.Status}}' "$DB") == healthy ]]
[[ $(dc network inspect --format '{{index .Labels "orloom.packet"}} {{.Internal}}' "$NET") == "$L true" ]]
[[ $(dc volume inspect --format '{{index .Labels "orloom.packet"}}' "$SECRET") == "$L" ]]
[[ -f "$ROOT/verifier-image.id" && ! -L "$ROOT/verifier-image.id" ]]
image=$(cat "$ROOT/verifier-image.id"); [[ $image =~ ^sha256:[a-f0-9]{64}$ && $(dc image inspect --format '{{.Id}}' "$image") == "$image" ]]
if [[ -e /var/lib/orloom/verifier/state || -L /var/lib/orloom/verifier/state ]]; then [[ -f /var/lib/orloom/verifier/state && ! -L /var/lib/orloom/verifier/state && ! -s /var/lib/orloom/verifier/state ]]; fi
[[ -z $(dc ps -a --no-trunc --filter 'label=orloom.packet=ORL-C3' -q) ]]
[[ $(sha256sum "$STAGING/node" | cut -d' ' -f1) == d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c ]]
(cd "$STAGING/payload" && sha256sum --check "$STAGING/payload-manifest.sha256" >/dev/null)
ip=$(dc inspect --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "$DB"); python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.argv[1]); assert a.is_private and not a.is_loopback' "$ip"
secret_tmp=$(mktemp "$STAGING/app-secret.XXXXXX"); chmod 0600 "$secret_tmp"; dc cp "$DB:/run/secrets/app" "$secret_tmp"
password=$(cat "$secret_tmp"); [[ $password =~ ^[a-f0-9]{64}$ ]]; unset password
urlfile="$STAGING/database-url"; [[ ! -e $urlfile && ! -L $urlfile ]]
password=$(cat "$secret_tmp"); printf 'postgres://mission_app:%s@%s:5432/mission_proof\n' "$password" "$ip" > "$urlfile"; unset password; chmod 0400 "$urlfile"; rm -f -- "$secret_tmp"
runid=$(cat /proc/sys/kernel/random/uuid); runid=${runid//-/}; evidence="$ROOT/evidence/c3-$runid"; install -d -m 0700 "$evidence"
repo_map=$(printf '{"nrsandoval1231-oss/orloom":{"objectStore":"%s/source.git","approvedRef":"refs/heads/candidate"}}' "$STAGING")
launcher="$ROOT/source/infra/verifier-isolation/launch-verifier.sh"; [[ -f $launcher && ! -L $launcher ]]
set +e
(cd "$STAGING/payload/orloom-ci" && env -i PATH=/usr/bin:/bin HOME=/root LANG=C \
 ORLOOM_PROOF_DATABASE_URL_FILE="$urlfile" ORLOOM_PROOF_OBJECT_STORE="$STAGING/source.git" \
 ORLOOM_PROOF_BASE_SHA="$base" ORLOOM_PROOF_CANDIDATE_SHA="$candidate" \
 ORLOOM_PROOF_CAPACITY_EVIDENCE_SHA256="$(sha256sum "$ROOT/capacity-evidence.json" | cut -d' ' -f1)" \
 ORLOOM_VERIFIER_IMAGE="$image" ORLOOM_VERIFIER_ID=c3-runsc-verifier ORLOOM_VERIFIER_ARTIFACT_ROOT="$ROOT/artifacts" \
 ORLOOM_PROOF_EVIDENCE_DIR="$evidence" ORLOOM_PROOF_REPOSITORY=nrsandoval1231-oss/orloom ORLOOM_PROOF_APPROVED_REF=refs/heads/candidate \
 ORLOOM_PROOF_DOCKER_CONFIG="$config" \
 ORLOOM_VERIFIER_REPOSITORIES="$repo_map" ORLOOM_VERIFIER_LAUNCHER="$launcher" \
 "$STAGING/node" ../c3-runtime-proof/runtime-proof.mjs > "$evidence/runner-output.txt" 2> "$evidence/runner-error.txt")
status=$?; set -e; printf '%s\n' "$status" > "$evidence/exit-code.txt"
if (( status != 0 )); then echo "proof failed closed; inspect evidence directory $evidence (exit=$status)" >&2; exit "$status"; fi
grep -q '"status":"PASS"' "$evidence/runner-output.txt"
(cd "$evidence" && find . -type f ! -name evidence-files.sha256 -print0 | sort -z | xargs -0 sha256sum) > "$evidence/evidence-files.sha256"
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$EXPECTED_PROTECTED" ]]
echo "runtime_proof=PASS candidate=$candidate evidence=$evidence image=$image"
