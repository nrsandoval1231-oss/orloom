#!/usr/bin/env bash
set -euo pipefail
readonly DOCKER=/usr/bin/docker SOCKET=unix:///var/run/docker.sock ROOT=/var/lib/orloom/c3-proof-20261013
readonly BASE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly EXPECTED_CANDIDATE=765943eae18c09aa882e52c7f5255dd776c5fd43 EXPECTED_SOURCE_MANIFEST=91c672bd6519df3ef6344878cb75ddd81eb9285c9ad15f5528c85710ad89a211
[[ $EUID -eq 0 && $# -eq 3 && $1 == prepare && $2 =~ ^[a-f0-9]{40}$ && $3 =~ ^[a-f0-9]{64}$ && -d $ROOT/source && ! -L $ROOT/source && ! -L $ROOT ]]
[[ $2 == "$EXPECTED_CANDIDATE" && $3 == "$EXPECTED_SOURCE_MANIFEST" ]]
[[ -f "$ROOT/incoming/source-identity.json" && ! -L "$ROOT/incoming/source-identity.json" && -f "$ROOT/incoming/payload-identity.json" && ! -L "$ROOT/incoming/payload-identity.json" ]]
readonly EXPECTED_SHA=$2 EXPECTED_MANIFEST=$3
readonly SHA=$(jq -er '.candidateSha | select(test("^[a-f0-9]{40}$"))' "$ROOT/incoming/source-identity.json")
readonly TAG="orloom-c3-verifier:${SHA:0:12}"
[[ $SHA == "$EXPECTED_SHA" && $(jq -r .sourceManifestSha256 "$ROOT/incoming/payload-identity.json") == "$EXPECTED_MANIFEST" ]]
git_clean(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" "$@"; }
[[ $(git_clean rev-parse HEAD) == "$SHA" ]]
ref=$(jq -er .sourceRef "$ROOT/incoming/source-identity.json")
[[ $(git_clean rev-parse "${ref}^{commit}") == "$SHA" ]]
[[ -z $(git_clean status --porcelain=v1) ]]
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-MANIFEST.sha256" | cut -d' ' -f1) == $(jq -r .sourceManifestSha256 "$ROOT/incoming/payload-identity.json") ]]
config=$(mktemp -d /run/orloom-c3-docker.XXXXXX); chmod 0700 "$config"
trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$DOCKER" --config "$config" --host "$SOCKET" "$@"; }
[[ $(dc image inspect --format '{{.Id}}' "$BASE") == sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304 ]]
if dc image inspect "$TAG" >/dev/null 2>&1; then echo 'target tag already exists; refusing overwrite' >&2; exit 69; fi
dc build --pull=false --no-cache --network=none --label "orloom.packet=ORL-C3-$SHA" --tag "$TAG" --file "$ROOT/source/infra/verifier-isolation/Dockerfile" "$ROOT/source/infra/verifier-isolation"
id=$(dc image inspect --format '{{.Id}}' "$TAG"); [[ $id =~ ^sha256:[a-f0-9]{64}$ ]]
[[ $(dc image inspect --format '{{index .Config.Labels "orloom.packet"}}' "$id") == "ORL-C3-$SHA" ]]
[[ ! -e "$ROOT/verifier-image.id" && ! -L "$ROOT/verifier-image.id" ]]
printf '%s\n' "$id" > "$ROOT/verifier-image.id"; chmod 0600 "$ROOT/verifier-image.id"
dc image inspect --format '{{json .}}' "$id" | jq '{Id,RepoDigests,Created,Config:{Image:.Config.Image,Labels:.Config.Labels,User:.Config.User},RootFS}' > "$ROOT/verifier-image-inspect.json"; chmod 0600 "$ROOT/verifier-image-inspect.json"
echo "image_build=PASS image_id=$id pull=false"
