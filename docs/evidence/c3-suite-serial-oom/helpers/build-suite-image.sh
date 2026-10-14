#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-serial-20261013 LABEL=ORL-C3-SUITE-SERIAL D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 && -f "$ROOT/stage-bindings.json" && ! -L "$ROOT/stage-bindings.json" && -d "$ROOT/source" && ! -L "$ROOT/source" && ! -e "$ROOT/verifier-image.id" && ! -L "$ROOT/verifier-image.id" ]] || { echo 'acceptance source is not safely staged' >&2; exit 66; }
candidate=$(jq -er '.candidateSha|select(test("^[a-f0-9]{40}$"))' "$ROOT/stage-bindings.json"); manifest=$(jq -er '.sourceManifestSha256|select(test("^[a-f0-9]{64}$"))' "$ROOT/stage-bindings.json")
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$manifest" && -z $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" status --porcelain=v1) ]] || { echo 'staged source is not clean/bound' >&2; exit 65; }
base=$(awk '$1=="FROM" {print $2; exit}' "$ROOT/source/infra/verifier-isolation/Dockerfile"); [[ $base =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Dockerfile base is not digest pinned' >&2; exit 65; }
config=$(mktemp -d /run/orloom-c3-suite-acceptance-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin HOME=/root "$D" --config "$config" --host "$SOCKET" "$@"; }
[[ -n $(dc image inspect --format '{{.Id}}' "$base") ]] || { echo 'pinned base image is unavailable' >&2; exit 69; }
tag="orloom-c3-suite-acceptance:${candidate:0:12}"
[[ -z $(dc image ls --quiet "$tag") ]] || { echo 'deterministic acceptance image tag already exists; refusing replacement' >&2; exit 73; }
dc build --pull=false --label "orloom.packet=$LABEL" --label "orloom.candidate=$candidate" -t "$tag" -f "$ROOT/source/infra/verifier-isolation/Dockerfile" "$ROOT/source" >/dev/null
image=$(dc image inspect --format '{{.Id}}' "$tag"); [[ $image =~ ^sha256:[a-f0-9]{64}$ && $(dc image inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.candidate"}}' "$image") == "$image|$LABEL|$candidate" ]] || { echo 'acceptance image identity mismatch' >&2; exit 70; }
printf '%s\n' "$image" > "$ROOT/verifier-image.id"; chmod 0400 "$ROOT/verifier-image.id"
printf '{"candidateSha":"%s","sourceManifestSha256":"%s","image":"%s"}\n' "$candidate" "$manifest" "$image" > "$ROOT/image-binding.json"; chmod 0400 "$ROOT/image-binding.json"
