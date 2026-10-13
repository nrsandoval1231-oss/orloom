#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker S=unix:///var/run/docker.sock L=ORL-C3-PROOF PREFIX=orloom-c3-proof-20261013
readonly ROOT=/var/lib/orloom/c3-proof-20261013 STAGING=/var/lib/orloom/c3-proof-20261013/staging DB=$PREFIX-db NET=$PREFIX-net DATA=$PREFIX-data SECRET=$PREFIX-secrets
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
[[ $EUID -eq 0 && $# -eq 1 && ( $1 == inspect || $1 == cleanup ) && -d $ROOT && ! -L $ROOT ]]
config=$(mktemp -d /run/orloom-c3-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
[[ -f "$ROOT/resources.tsv" && ! -L "$ROOT/resources.tsv" ]]
dbid=$(awk '$1=="database" {print $2}' "$ROOT/resources.tsv"); netid=$(awk '$1=="network" {print $2}' "$ROOT/resources.tsv"); dataid=$(awk '$1=="data-volume" {print $2}' "$ROOT/resources.tsv"); secretid=$(awk '$1=="secret-volume" {print $2}' "$ROOT/resources.tsv"); seedid=$(awk '$1=="seed" {print $2}' "$ROOT/resources.tsv"); seedremoved=$(awk '$1=="seed-removed" {print $2}' "$ROOT/resources.tsv")
[[ $dbid =~ ^[a-f0-9]{64}$ && $netid =~ ^[a-f0-9]{64}$ && $dataid == "$DATA" && $secretid == "$SECRET" && $seedid =~ ^[a-f0-9]{64}$ && $seedremoved == "$seedid" ]]
! dc inspect "$seedid" >/dev/null 2>&1
[[ $(dc inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{.Image}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Binds}}' "$dbid") == "$dbid|$L|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24|{}|null" ]]
[[ $(dc network inspect --format '{{.Id}}|{{index .Labels "orloom.packet"}}|{{.Internal}}|{{range .Containers}}{{.Name}}{{end}}' "$netid") == "$netid|$L|true|$DB" ]]
[[ $(dc volume inspect --format '{{.Name}}|{{index .Labels "orloom.packet"}}' "$dataid") == "$DATA|$L" ]]
[[ $(dc volume inspect --format '{{.Name}}|{{index .Labels "orloom.packet"}}' "$secretid") == "$SECRET|$L" ]]
[[ $(dc ps -a --no-trunc --filter "volume=$dataid" --format '{{.ID}}') == "$dbid" ]]
[[ $(dc ps -a --no-trunc --filter "volume=$secretid" --format '{{.ID}}') == "$dbid" ]]
[[ -d /run/orloom-verifier-lock && ! -L /run/orloom-verifier-lock && -f /run/orloom-verifier-lock/slot.lock && ! -L /run/orloom-verifier-lock/slot.lock ]]
/usr/bin/flock -n /run/orloom-verifier-lock/slot.lock /bin/true
if [[ -e /var/lib/orloom/verifier/state || -L /var/lib/orloom/verifier/state ]]; then [[ -f /var/lib/orloom/verifier/state && ! -L /var/lib/orloom/verifier/state && ! -s /var/lib/orloom/verifier/state ]]; fi
[[ -z $(dc ps -a --no-trunc --filter 'label=orloom.packet=ORL-C3' -q) ]]
[[ -d "$ROOT/evidence" && ! -L "$ROOT/evidence" && -d "$ROOT/artifacts" && ! -L "$ROOT/artifacts" ]]
if [[ $1 == inspect ]]; then echo 'cleanup_preflight=PASS exact labeled resources; evidence and artifacts retained; protected container unchanged'; exit 0; fi
[[ -f "$ROOT/cleanup-approval.txt" && ! -L "$ROOT/cleanup-approval.txt" ]]
[[ $(cat "$ROOT/cleanup-approval.txt") == "ORL-C3-REVIEWED-CLEANUP $dbid $netid $dataid $secretid" ]]
[[ -d "$STAGING" && ! -L "$STAGING" && $(realpath -e "$STAGING") == "$STAGING" ]]
echo 'cleanup starts: exact database, volumes, network and staging only'
dc rm -f "$dbid" >/dev/null; dc volume rm "$secretid" "$dataid" >/dev/null; dc network rm "$netid" >/dev/null
rm -rf -- "$STAGING"
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
[[ -d "$ROOT/evidence" && -d "$ROOT/artifacts" ]]
echo 'cleanup=PASS runtime resources removed; evidence, artifacts and resource records retained'
