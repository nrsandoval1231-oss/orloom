#!/usr/bin/env bash
set -euo pipefail

readonly DOCKER=/usr/bin/docker
readonly IMAGE='ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304'
readonly SOCKET='unix:///var/run/docker.sock'

refuse() { printf 'worker sandbox launch refused: %s\n' "$1" >&2; exit "${2:-64}"; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || refuse 'must run as host root'

# Reject inherited daemon-selection, product, provider, or account credentials by name only.
while IFS= read -r name; do
  case "$name" in
    DOCKER_*|ORLOOM_*|CODEX_*|GITHUB_*|AWS_*|AZURE_*|R2_*|*_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_CREDENTIAL*)
      [[ -z ${!name:-} ]] || refuse "inherited sensitive environment variable is set: $name" 65
      ;;
  esac
done < <(compgen -e)

[[ $# -eq 1 ]] || refuse 'accepts exactly one sandbox name; Docker options and command overrides are not accepted'
name=$1
[[ $name =~ ^orloom-worker-[a-z0-9][a-z0-9-]{0,32}$ ]] || refuse 'invalid sandbox name'
[[ -x $DOCKER ]] || refuse 'local Docker CLI is unavailable' 69

config_dir=$(mktemp -d /run/orloom-iso-docker-config.XXXXXX)
chmod 0700 "$config_dir"
cleanup() { rm -rf -- "$config_dir"; }
trap cleanup EXIT HUP INT TERM

# Never pull here: only the preloaded, digest-pinned image may execute.
"$DOCKER" --config "$config_dir" --host "$SOCKET" image inspect "$IMAGE" >/dev/null 2>&1 || refuse 'pinned worker image is not present locally' 69
id=$("$DOCKER" --config "$config_dir" --host "$SOCKET" run --detach --rm \
  --pull=never \
  --name "$name" \
  --runtime=runsc \
  --network=none \
  --read-only \
  --user=65532:65532 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --pids-limit=64 \
  --memory=256m \
  --memory-swap=256m \
  --cpus=0.5 \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700 \
  --tmpfs=/work:rw,exec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700 \
  --entrypoint=/bin/sh \
  "$IMAGE" -ec 'while :; do sleep 3600; done') || refuse 'sandbox container did not start' 70
state=$("$DOCKER" --config "$config_dir" --host "$SOCKET" inspect --format '{{.State.Status}}' "$id")
[[ $state == running ]] || refuse 'sandbox container failed readiness' 70
printf '%s\n' "$id"
