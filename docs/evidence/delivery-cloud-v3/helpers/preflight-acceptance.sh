#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock PG=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly ROOT=/var/lib/orloom/c3-delivery-v3-20261013
readonly INCOMING=$ROOT.incoming
readonly OUT=$INCOMING/preflight
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 && ! -e "$ROOT" && ! -L "$ROOT" && -d "$INCOMING" && ! -L "$INCOMING" && ! -e "$OUT" && ! -L "$OUT" ]] || { echo 'usage: root preflight-acceptance.sh with fresh fixed incoming root' >&2; exit 64; }
[[ -d /var/lib && ! -L /var/lib && -r /proc/meminfo ]] || { echo 'trusted host inputs unavailable' >&2; exit 69; }
config=$(mktemp -d /run/orloom-c3-delivery-v3-20261013-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin HOME=/root "$D" --config "$config" --host "$SOCKET" "$@"; }
protected=$(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal); [[ $protected =~ ^[a-f0-9]{64}\ [^[:space:]]+\ 0\ runc\ running$ ]] || { echo 'protected container identity is not admissible' >&2; exit 69; }
[[ $protected == "$PROTECTED" ]] || { echo 'protected container identity differs from accepted host binding' >&2; exit 69; }
dc info --format '{{json .Runtimes}}' | jq -e '.runsc != null' >/dev/null || { echo 'runsc is not registered' >&2; exit 69; }
[[ ! -e /var/lib/orloom/verifier/state && ! -L /var/lib/orloom/verifier/state ]] || { echo 'verifier state exists; reconcile without dispatch' >&2; exit 75; }
/usr/bin/flock -n /run/orloom-verifier-lock/slot.lock /bin/true || { echo 'verifier slot busy' >&2; exit 75; }
[[ -z $(dc ps -aq --filter label=orloom.packet=ORL-C3) ]] || { echo 'old verifier resource remains' >&2; exit 75; }
pgid=$(dc image inspect --format '{{.Id}}' "$PG"); [[ $pgid =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'pinned PostgreSQL image unavailable' >&2; exit 69; }
memory=$(awk '$1=="MemAvailable:" {printf "%.0f",$2*1024}' /proc/meminfo); disk=$(df -PB1 /var/lib | awk 'NR==2{print $4}'); [[ $memory =~ ^[0-9]+$ && $disk =~ ^[0-9]+$ ]] || { echo 'capacity observation unavailable' >&2; exit 69; }
install -d -m 0700 "$OUT"
printf '{"hostMutation":false,"images":{"postgres":"%s"},"protectedContainer":"%s","providerCalls":0,"runscRegistered":true}\n' "$PG" "$protected" > "$OUT/preflight.json"
printf '{"format":"orloom-c3-delivery-cloud-capacity-observation-v1","observedAt":"%s","availableMemoryBytes":%s,"availableDiskBytes":%s,"protectedContainer":"%s","postgresImage":"%s","postgresImageId":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$memory" "$disk" "$protected" "$PG" "$pgid" > "$OUT/capacity-observation.json"
chmod 0400 "$OUT/preflight.json" "$OUT/capacity-observation.json"
