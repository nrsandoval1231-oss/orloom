#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock
readonly ROOT=/var/lib/orloom/c3-suite-proof-20261013
readonly LABEL=ORL-C3-SUITE-PROOF BASE_IMAGE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
[[ $EUID -eq 0 && $# -eq 4 && $1 == prepare && $2 =~ ^[a-f0-9]{40}$ && $3 =~ ^[a-f0-9]{40}$ && $4 =~ ^[a-f0-9]{64}$ ]]
[[ -d $ROOT/source && ! -L $ROOT/source && -d $ROOT/incoming && ! -L $ROOT/incoming ]]
readonly BASE_SHA=$2 CANDIDATE=$3 MANIFEST=$4
gitc(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" "$@"; }
[[ $(gitc rev-parse HEAD) == "$CANDIDATE" && -z $(gitc status --porcelain=v1) ]]
[[ $(gitc rev-parse 'refs/heads/feat/trusted-verification-suite^{commit}') == "$CANDIDATE" ]]
gitc merge-base --is-ancestor "$BASE_SHA" "$CANDIDATE"
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$MANIFEST" ]]
[[ $(sha256sum "$ROOT/capacity-evidence.json" | cut -d' ' -f1) == $(jq -er '.preflightSha256' "$ROOT/setup-capacity.json") ]]
config=$(mktemp -d /run/orloom-c3-suite-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$SOCKET" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
[[ $(dc image inspect --format '{{.Id}}' "$BASE_IMAGE") == sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304 ]]
readonly TAG="orloom-c3-suite:${CANDIDATE:0:12}"
if dc image inspect "$TAG" >/dev/null 2>&1; then echo 'target image tag already exists; refusing overwrite' >&2; exit 69; fi
# Root context is required by Dockerfile COPY instructions. Only locked npm packages are fetched.
dc build --pull=false --no-cache --network=default --label "orloom.packet=$LABEL" --label "orloom.base=$BASE_SHA" --label "orloom.candidate=$CANDIDATE" --tag "$TAG" --file "$ROOT/source/infra/verifier-isolation/Dockerfile" "$ROOT/source"
readonly IMAGE=$(dc image inspect --format '{{.Id}}' "$TAG")
[[ $IMAGE =~ ^sha256:[a-f0-9]{64}$ && $(dc image inspect --format '{{index .Config.Labels "orloom.packet"}} {{index .Config.Labels "orloom.candidate"}}' "$IMAGE") == "$LABEL $CANDIDATE" ]]
[[ ! -e $ROOT/verifier-image.id && ! -L $ROOT/verifier-image.id ]]
printf '%s\n' "$IMAGE" > "$ROOT/verifier-image.id"; chmod 0600 "$ROOT/verifier-image.id"
dc image inspect --format '{{json .}}' "$IMAGE" | jq '{Id,RepoDigests,Created,Config:{Image:.Config.Image,Labels:.Config.Labels,User:.Config.User},RootFS}' > "$ROOT/verifier-image-inspect.json"
chmod 0400 "$ROOT/verifier-image-inspect.json"
echo "image_build=PASS candidate=$CANDIDATE image=$IMAGE"
