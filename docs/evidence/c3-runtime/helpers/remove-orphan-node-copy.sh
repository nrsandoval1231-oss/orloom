#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker S=unix:///var/run/docker.sock ROOT=/var/lib/orloom/c3-proof-20261013
readonly CID=61fda97bd516ffc66ab86a11e0bd69011404170ca2c0ef8b549913558c52efd5
readonly NAME=/orloom-c3-proof-20261013-node-copy LABEL=ORL-C3-PROOF
readonly BASE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly IMAGE=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
[[ $EUID -eq 0 && $# -ge 1 && ( $1 == inspect || $1 == remove-reviewed ) ]]
if [[ $1 == inspect ]]; then [[ $# -eq 1 ]]; else [[ $# -eq 2 && $2 == "$CID" ]]; fi
config=$(mktemp -d /run/orloom-c3-docker.XXXXXX); chmod 0700 "$config"
trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" "$@"; }
raw=$(dc inspect --format '{{json .}}' "$CID")
printf '%s\n' "$raw" | jq -e --arg id "$CID" --arg name "$NAME" --arg label "$LABEL" --arg base "$BASE" --arg image "$IMAGE" '
  .Id == $id and .Name == $name and .Config.Labels["orloom.packet"] == $label and
  .Config.Image == $base and .Image == $image and
  (.State.Status == "created" or .State.Status == "exited") and .State.Running == false and
  .HostConfig.NetworkMode == "none" and .HostConfig.ReadonlyRootfs == true
' >/dev/null
printf '%s\n' "$raw" | jq '{Id,Name,Image,State:{Status:.State.Status,Running:.State.Running},Config:{Image:.Config.Image,Labels:.Config.Labels},HostConfig:{NetworkMode:.HostConfig.NetworkMode,ReadonlyRootfs:.HostConfig.ReadonlyRootfs}}'
if [[ $1 == inspect ]]; then echo 'orphan_preflight=PASS exact stopped C3 Node-copy container'; exit 0; fi
[[ -f "$ROOT/resources.tsv" && ! -L "$ROOT/resources.tsv" ]]
cidfile="$ROOT/node-copy-container-$CID.id"; [[ ! -e "$cidfile" && ! -L "$cidfile" ]]
printf '%s\n' "$CID" > "$cidfile"; chmod 0600 "$cidfile"
printf 'node-copy-orphan\t%s\n' "$CID" >> "$ROOT/resources.tsv"
dc rm "$CID" >/dev/null
printf 'node-copy-orphan-removed\t%s\n' "$CID" >> "$ROOT/resources.tsv"
if dc inspect "$CID" >/dev/null 2>&1; then echo 'orphan_removal=UNKNOWN exact CID remains inspectable' >&2; exit 70; fi
echo 'orphan_removal=PASS exact stopped container removed'
