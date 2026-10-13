#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock LABEL=ORL-C3-SUITE-PROOF PREFIX=orloom-c3-suite-proof-20261013 ROOT=/var/lib/orloom/c3-suite-proof-20261013
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
[[ $EUID -eq 0 && $# -eq 2 && $1 == cleanup && $2 =~ ^[a-f0-9]{40}$ ]]
[[ -d $ROOT && ! -L $ROOT && -f $ROOT/resources.tsv && ! -L $ROOT/resources.tsv ]]
config=$(mktemp -d /run/orloom-c3-suite-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$SOCKET" "$@"; }
protected(){ [[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]; }
protected
awk -F '\t' 'NF!=2 || $1=="" || $2=="" || seen[$1]++ {exit 1}' "$ROOT/resources.tsv" || { echo 'resource ledger malformed' >&2; exit 69; }
get(){ awk -F '\t' -v key="$1" '$1==key {print $2}' "$ROOT/resources.tsv"; }
readonly DB=$PREFIX-db NET=$PREFIX-net DATA=$PREFIX-data SECRET=$PREFIX-secrets
record(){ printf '%s\t%s\n' "$1" "$2" >> "$ROOT/resources.tsv"; }
# Validate every remaining recorded target before the first mutation.
db_id=$(get database); db_removed=$(get database-removed)
net_id=$(get network); net_removed=$(get network-removed)
seed_id=$(get seed); seed_removed=$(get seed-removed)
if [[ -n $db_id && -z $db_removed ]]; then [[ $db_id =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Image}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Binds}}' "$db_id") == "$db_id|/$DB|$LABEL|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24|{}|null" ]]; fi
if [[ -n $net_id && -z $net_removed ]]; then [[ $net_id =~ ^[a-f0-9]{64}$ && $(dc network inspect --format '{{.Id}}|{{.Name}}|{{index .Labels "orloom.packet"}}|{{.Driver}}|{{.Internal}}' "$net_id") == "$net_id|$NET|$LABEL|bridge|true" ]]; fi
if [[ -n $seed_id && -z $seed_removed ]]; then [[ $seed_id =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Image}}' "$seed_id") == "$seed_id|/$PREFIX-seed|$LABEL|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24" ]]; fi
for key in data-volume secret-volume; do volume_id=$(get "$key"); volume_removed=$(get "$key-removed"); if [[ -n $volume_id && -z $volume_removed ]]; then expected=$DATA; [[ $key == secret-volume ]] && expected=$SECRET; [[ $volume_id == "$expected" && $(dc volume inspect --format '{{.Name}}|{{index .Labels "orloom.packet"}}' "$volume_id") == "$expected|$LABEL" ]]; fi; done
node_id=$(get node-copy); node_removed=$(get node-copy-removed)
if [[ -n $node_id && -z $node_removed ]]; then [[ $node_id =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Config.Image}}|{{.Image}}' "$node_id") == "$node_id|/orloom-c3-suite-proof-20261013-node-copy|$LABEL|ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304|sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304" ]]; fi
if [[ -f $ROOT/verifier-image.id && ! -L $ROOT/verifier-image.id ]]; then image=$(cat "$ROOT/verifier-image.id"); [[ $image =~ ^sha256:[a-f0-9]{64}$ && $(dc image inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.candidate"}}' "$image") == "$image|$LABEL|$2" ]]; fi
if [[ -e $ROOT/staging/database-url || -L $ROOT/staging/database-url ]]; then [[ -f $ROOT/staging/database-url && ! -L $ROOT/staging/database-url && $(stat -c '%a' "$ROOT/staging/database-url") == 400 ]]; fi
if [[ -n $db_id && -z $db_removed ]]; then dc rm --force "$db_id" >/dev/null; record database-removed "$db_id"; fi
if [[ -n $seed_id && -z $seed_removed ]]; then dc rm --force "$seed_id" >/dev/null; record seed-removed "$seed_id"; fi
if [[ -n $net_id && -z $net_removed ]]; then dc network rm "$net_id" >/dev/null; record network-removed "$net_id"; fi
for key in data-volume secret-volume; do volume_id=$(get "$key"); volume_removed=$(get "$key-removed"); if [[ -n $volume_id && -z $volume_removed ]]; then removed_key=$key-removed; dc volume rm "$volume_id" >/dev/null; record "$removed_key" "$volume_id"; fi; done
if [[ -n $node_id && -z $node_removed ]]; then dc rm --force "$node_id" >/dev/null; record node-copy-removed "$node_id"; fi
if [[ -f $ROOT/verifier-image.id && ! -L $ROOT/verifier-image.id ]]; then
  image=$(cat "$ROOT/verifier-image.id"); [[ $image =~ ^sha256:[a-f0-9]{64}$ ]]
  [[ $(dc image inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.candidate"}}' "$image") == "$image|$LABEL|$2" ]]
fi
if [[ -e $ROOT/staging/database-url || -L $ROOT/staging/database-url ]]; then
  [[ -f $ROOT/staging/database-url && ! -L $ROOT/staging/database-url && $(stat -c '%a' "$ROOT/staging/database-url") == 400 ]]
  rm -f -- "$ROOT/staging/database-url"; record database-url-removed root-only
  [[ ! -e $ROOT/staging/database-url && ! -L $ROOT/staging/database-url ]]
fi
protected
echo 'postgres_cleanup=PASS exact-recorded IDs removed; evidence and fixture files retained'
