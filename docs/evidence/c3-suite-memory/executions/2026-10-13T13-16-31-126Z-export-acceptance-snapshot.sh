#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-memory-20261013
readonly NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
readonly BINDINGS=$ROOT/stage-bindings.json SNAPSHOT=$ROOT/evidence/acceptance-snapshot.json CHECKSUM=$ROOT/evidence/acceptance-snapshot.sha256
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 && -f "$ROOT/runtime-started.json" && ! -L "$ROOT/runtime-started.json" && $(stat -c '%a' "$ROOT/runtime-started.json") == 400 ]] || { echo 'runtime marker is missing or unsafe' >&2; exit 66; }
[[ -d "$ROOT/evidence" && ! -L "$ROOT/evidence" && -f "$ROOT/staging/node" && ! -L "$ROOT/staging/node" && $(sha256sum "$ROOT/staging/node" | cut -d' ' -f1) == "$NODE_SHA" ]] || { echo 'acceptance export runtime is unavailable' >&2; exit 66; }
[[ -f "$ROOT/staging/database-url" && ! -L "$ROOT/staging/database-url" && $(stat -c '%a' "$ROOT/staging/database-url") == 400 && -f "$BINDINGS" && ! -L "$BINDINGS" && -f "$ROOT/runtime-snapshot-export.mjs" && ! -L "$ROOT/runtime-snapshot-export.mjs" ]] || { echo 'acceptance export inputs are incomplete' >&2; exit 66; }
snapshot_sha=$(jq -er '.runtimeSnapshotSha256|select(test("^[a-f0-9]{64}$"))' "$BINDINGS") || { echo 'snapshot exporter binding is invalid' >&2; exit 65; }
[[ $(sha256sum "$ROOT/runtime-snapshot-export.mjs" | cut -d' ' -f1) == "$snapshot_sha" ]] || { echo 'snapshot exporter differs from staged binding' >&2; exit 65; }
set +e
env -i PATH=/usr/bin:/bin HOME=/root ORLOOM_ACCEPTANCE_CONTROL_ROOT="$ROOT/runtime-files" "$ROOT/staging/node" "$ROOT/runtime-snapshot-export.mjs" "$ROOT/staging/database-url" "$ROOT/evidence" "$BINDINGS"
status=$?
set -e
(( status == 0 )) || { echo 'acceptance snapshot query failed; retain runtime evidence and do not clean up' >&2; exit 75; }
[[ -f "$SNAPSHOT" && ! -L "$SNAPSHOT" && $(stat -c '%a' "$SNAPSHOT") == 400 && -f "$CHECKSUM" && ! -L "$CHECKSUM" && $(stat -c '%a' "$CHECKSUM") == 400 ]] || { echo 'database query did not produce a protected snapshot and checksum' >&2; exit 75; }
jq -e --arg candidate "$(jq -r .candidateSha "$BINDINGS")" --arg manifest "$(jq -r .sourceManifestSha256 "$BINDINGS")" 'type=="object" and (keys|sort)==["attempts","candidateSha","certificates","exportedAt","format","querySucceeded","sourceManifestSha256"] and .format=="orloom-c3-suite-acceptance-snapshot-v1" and .querySucceeded==true and .candidateSha==$candidate and .sourceManifestSha256==$manifest and (.attempts|type=="array") and (.certificates|type=="array")' "$SNAPSHOT" >/dev/null || { echo 'database snapshot schema or source binding is invalid' >&2; exit 75; }
(cd "$ROOT/evidence" && sha256sum --check acceptance-snapshot.sha256 >/dev/null) || { echo 'acceptance snapshot checksum differs' >&2; exit 75; }
echo 'acceptance_snapshot=PASS source=read-only-postgresql allowlist=verified'
