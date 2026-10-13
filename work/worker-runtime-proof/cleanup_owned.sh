#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo 'usage: cleanup_owned.sh SOURCE_SHA256 DOCKERFILE_SHA256 SANDBOX_SOURCE_SHA256 COMPILED_ENTRY_SHA256 NAME=CONTAINER_ID [...]' >&2
  exit 2
fi
source_sha=$1; dockerfile_sha=$2; source_sha_file=$3; entry_sha=$4; shift 4
for value in "$source_sha" "$dockerfile_sha" "$source_sha_file" "$entry_sha"; do
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo 'refusing malformed provenance digest' >&2; exit 2; }
done
config=$(mktemp -d /tmp/orloom-proof-docker-config.XXXXXX)
case "$config" in /tmp/orloom-proof-docker-config.*) ;; *) echo 'unsafe Docker config path' >&2; exit 9 ;; esac
chmod 0700 "$config"
cleanup_config() {
  case "$config" in /tmp/orloom-proof-docker-config.*) rm -rf -- "$config" ;; *) echo 'unsafe Docker config cleanup path' >&2; return 9 ;; esac
}
trap cleanup_config EXIT
export DOCKER_CONFIG="$config" HOME=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
for pair in "$@"; do
  [[ "$pair" == *=* ]] || { echo 'refusing container without explicit name and ID' >&2; exit 2; }
  name=${pair%%=*}; id=${pair#*=}
  [[ "$name" =~ ^orloom-worker-proof-[0-9]+-[0-9]+-[a-f0-9]{8}-[ab]$ ]] || { echo 'refusing non-proof container name' >&2; exit 2; }
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { echo 'refusing malformed container ID' >&2; exit 2; }
  actual=$(/usr/bin/docker --config "$config" --host unix:///var/run/docker.sock inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "org.orloom.worker-runtime-proof"}}|{{index .Config.Labels "org.orloom.proof.source-manifest-sha256"}}|{{index .Config.Labels "org.orloom.proof.dockerfile-sha256"}}|{{index .Config.Labels "org.orloom.proof.sandbox-source-sha256"}}|{{index .Config.Labels "org.orloom.proof.compiled-entry-sha256"}}|{{index .Config.Labels "org.orloom.proof.node-base"}}' "$id")
  expected="$id|/$name|true|$source_sha|$dockerfile_sha|$source_sha_file|$entry_sha|node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd"
  [[ "$actual" == "$expected" ]] || { echo 'refusing container whose exact ID/name/provenance labels differ' >&2; exit 3; }
  /usr/bin/docker --config "$config" --host unix:///var/run/docker.sock rm --force "$id" >/dev/null
  printf 'removed_owned_test_container=%s\n' "$id"
done
