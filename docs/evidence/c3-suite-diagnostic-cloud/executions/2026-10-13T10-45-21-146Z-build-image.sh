#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-diagnostic-20261013 D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 ]] || { echo 'usage: root build-image.sh' >&2; exit 64; }
[[ -d $ROOT/source.git && ! -L $ROOT/source.git && -d $ROOT/source && ! -L $ROOT/source && -f $ROOT/stage-bindings.json && ! -L $ROOT/stage-bindings.json ]] || { echo 'run staging first' >&2; exit 66; }
config=$(mktemp -d /run/orloom-c3-suite-diagnostic-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin HOME=/root "$D" --config "$config" --host "$SOCKET" "$@"; }
candidate=$(jq -r .candidateSha "$ROOT/stage-bindings.json")
[[ $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" rev-parse HEAD) == "$candidate" && -z $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" status --porcelain=v1) ]] || { echo 'source identity is not frozen' >&2; exit 65; }
base=$(awk '/^FROM ghcr.io\/openai\/codex-universal@sha256:/{sub(/^FROM /, ""); sub(/ AS .*/, ""); print; exit}' "$ROOT/source/infra/verifier-isolation/Dockerfile")
[[ $base =~ ^ghcr\.io/openai/codex-universal@sha256:[a-f0-9]{64}$ ]] || { echo 'source Dockerfile base is not digest pinned' >&2; exit 65; }
dc image inspect "$base" >/dev/null || { echo 'pinned base is not cached locally' >&2; exit 69; }
tag="orloom-c3-suite-diagnostic:${candidate:0:12}"
[[ -z $(dc image ls --quiet "$tag") ]] || { echo 'diagnostic image tag already exists; refusing replacement' >&2; exit 73; }
dc build --pull=false --label=orloom.packet=ORL-C3-SUITE-DIAGNOSTIC --label="orloom.candidate=$candidate" --tag "$tag" --file "$ROOT/source/infra/verifier-isolation/Dockerfile" "$ROOT/source" >/dev/null
actual=$(dc image inspect --format '{{.Id}}' "$tag")
printf '%s\n' "$actual" > "$ROOT/verifier-image.id"; chmod 0400 "$ROOT/verifier-image.id"
