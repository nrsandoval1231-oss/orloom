#!/usr/bin/env bash
set -euo pipefail

# Read-only host preflight proposal; this script does not build, pull, run, or delete containers.
readonly BASE='ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304'
readonly DOCKER=/usr/bin/docker
readonly SOCKET=unix:///var/run/docker.sock
[[ ${EUID:-$(id -u)} -eq 0 && -x $DOCKER ]] || { echo 'root and /usr/bin/docker are required' >&2; exit 69; }
config=$(mktemp -d /run/orloom-verifier-preflight.XXXXXX)
chmod 0700 "$config"
trap 'rm -rf -- "$config"' EXIT HUP INT TERM
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root "$DOCKER" --config "$config" --host "$SOCKET" image inspect "$BASE" >/dev/null
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root "$DOCKER" --config "$config" --host "$SOCKET" info --format '{{json .Runtimes}}'
df -h /var/lib/docker
free -m
printf '%s\n' 'Cached base image present. Runsc registration and host capacity reported above. Node binary hash is checked inside the derived image build; this read-only preflight does not extract image files or mutate containers.'
