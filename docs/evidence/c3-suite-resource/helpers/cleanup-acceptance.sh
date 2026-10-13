#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-resource-20261013 PREFIX=orloom-c3-suite-resource-20261013 LABEL=ORL-C3-SUITE-RESOURCE D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 && -d "$ROOT" && ! -L "$ROOT" && -f "$ROOT/resources.tsv" && ! -L "$ROOT/resources.tsv" ]] || { echo 'acceptance root/ledger unavailable' >&2; exit 64; }
awk -F '\t' 'NF!=2||$1==""||$2==""||seen[$1]++{exit 1}' "$ROOT/resources.tsv" || { echo 'malformed resource ledger' >&2; exit 69; }
get(){ awk -F '\t' -v k="$1" '$1==k{print $2}' "$ROOT/resources.tsv"; }; record(){ printf '%s\t%s\n' "$1" "$2" >> "$ROOT/resources.tsv"; }
config=$(mktemp -d /run/orloom-c3-suite-acceptance-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM; dc(){ env -i PATH=/usr/bin:/bin HOME=/root "$D" --config "$config" --host "$SOCKET" "$@"; }
pending(){ [[ -n $(get "$1") && -z $(get "$1-removed") ]]; }
check_container(){ local id=$1 name=$2; [[ $id =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}' "$id") == "$id|/$name|$LABEL" ]]; }
check_network(){ local id=$1; [[ $id =~ ^[a-f0-9]{64}$ && $(dc network inspect --format '{{.Id}}|{{.Name}}|{{index .Labels "orloom.packet"}}|{{.Internal}}' "$id") == "$id|$PREFIX-net|$LABEL|true" ]]; }
check_volume(){ local id=$1 name=$2; [[ $id == "$name" && $(dc volume inspect --format '{{.Name}}|{{index .Labels "orloom.packet"}}' "$id") == "$name|$LABEL" ]]; }
# Validate every recorded surviving resource before the first mutation. Missing
# ledger rows are allowed: setup can fail before DB creation.
if pending database; then check_container "$(get database)" "$PREFIX-db" || { echo 'database identity mismatch' >&2; exit 69; }; fi
if pending seed; then check_container "$(get seed)" "$PREFIX-seed" || { echo 'seed identity mismatch' >&2; exit 69; }; fi
if pending network; then check_network "$(get network)" || { echo 'network identity mismatch' >&2; exit 69; }; fi
if pending data-volume; then check_volume "$(get data-volume)" "$PREFIX-data" || { echo 'data volume identity mismatch' >&2; exit 69; }; fi
if pending secret-volume; then check_volume "$(get secret-volume)" "$PREFIX-secrets" || { echo 'secret volume identity mismatch' >&2; exit 69; }; fi
# A runtime marker means database data may contain an attempt. Its allowlisted
# snapshot must be retained before destructive cleanup; partial setup has none.
if [[ -e "$ROOT/runtime-started.json" || -L "$ROOT/runtime-started.json" ]]; then
  [[ -f "$ROOT/runtime-started.json" && ! -L "$ROOT/runtime-started.json" && $(stat -c '%a' "$ROOT/runtime-started.json") == 400 && -f "$ROOT/stage-bindings.json" && ! -L "$ROOT/stage-bindings.json" ]] || { echo 'runtime marker is unsafe; export/reconcile evidence before cleanup' >&2; exit 75; }
  marker_candidate=$(jq -r .candidateSha "$ROOT/stage-bindings.json"); marker_manifest=$(jq -r .sourceManifestSha256 "$ROOT/stage-bindings.json")
  jq -e --arg candidate "$marker_candidate" --arg manifest "$marker_manifest" 'type=="object" and (keys|sort)==["candidateSha","format","runId","sourceManifestSha256","startedAt"] and .format=="orloom-c3-suite-acceptance-runtime-started-v1" and .candidateSha==$candidate and .sourceManifestSha256==$manifest and (.runId|test("^[a-f0-9-]{36}$")) and (.startedAt|test("^[0-9TZ:-]+$"))' "$ROOT/runtime-started.json" >/dev/null || { echo 'runtime marker schema/source binding is unsafe' >&2; exit 75; }
  [[ -f "$ROOT/evidence/acceptance-snapshot.json" && ! -L "$ROOT/evidence/acceptance-snapshot.json" && -f "$ROOT/evidence/acceptance-snapshot.sha256" && ! -L "$ROOT/evidence/acceptance-snapshot.sha256" ]] || { echo "runtime evidence snapshot missing; export to $ROOT/evidence/acceptance-snapshot.json before cleanup" >&2; exit 75; }
  jq -e --arg candidate "$marker_candidate" --arg manifest "$marker_manifest" 'type=="object" and (keys|sort)==["attempts","candidateSha","certificates","exportedAt","format","querySucceeded","sourceManifestSha256"] and .format=="orloom-c3-suite-acceptance-snapshot-v1" and .querySucceeded==true and .candidateSha==$candidate and .sourceManifestSha256==$manifest and (.attempts|type=="array") and (.certificates|type=="array")' "$ROOT/evidence/acceptance-snapshot.json" >/dev/null || { echo 'runtime snapshot query result/binding is unsafe' >&2; exit 75; }
  (cd "$ROOT/evidence" && sha256sum --check acceptance-snapshot.sha256 >/dev/null) || { echo 'runtime evidence snapshot hash differs' >&2; exit 75; }
fi
if pending database; then dc rm --force "$(get database)" >/dev/null; record database-removed "$(get database)"; fi
if pending seed; then dc rm --force "$(get seed)" >/dev/null; record seed-removed "$(get seed)"; fi
if pending network; then dc network rm "$(get network)" >/dev/null; record network-removed "$(get network)"; fi
if pending data-volume; then dc volume rm "$(get data-volume)" >/dev/null; record data-volume-removed "$(get data-volume)"; fi
if pending secret-volume; then dc volume rm "$(get secret-volume)" >/dev/null; record secret-volume-removed "$(get secret-volume)"; fi
if [[ -e "$ROOT/staging/database-url" || -L "$ROOT/staging/database-url" ]]; then [[ -f "$ROOT/staging/database-url" && ! -L "$ROOT/staging/database-url" && $(stat -c '%a' "$ROOT/staging/database-url") == 400 ]] || exit 69; rm -f -- "$ROOT/staging/database-url"; record database-url-removed root-only; fi
echo 'acceptance_cleanup=PASS only exact recorded PostgreSQL resources removed; source, image, artifacts, and evidence retained'
