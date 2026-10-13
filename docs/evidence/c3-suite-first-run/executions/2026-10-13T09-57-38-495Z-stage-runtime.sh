#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock LABEL=ORL-C3-SUITE-PROOF PREFIX=orloom-c3-suite-proof-20261013
readonly ROOT=/var/lib/orloom/c3-suite-proof-20261013 BASE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly BASE_ID=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304 NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
readonly NAME=$PREFIX-node-copy PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
[[ $EUID -eq 0 && $# -eq 3 && $1 =~ ^[a-f0-9]{40}$ && $2 =~ ^[a-f0-9]{40}$ && $3 =~ ^[a-f0-9]{64}$ ]]
readonly BASE_SHA=$1 CANDIDATE=$2 SUITE_SHA=$3 REF=refs/heads/feat/trusted-verification-suite
[[ -d $ROOT/incoming && ! -L $ROOT/incoming && -d $ROOT/staging && ! -L $ROOT/staging && -f $ROOT/resources.tsv && ! -L $ROOT/resources.tsv ]]
readonly IDENTITY=$ROOT/incoming/candidate-identity.json BUNDLE=$ROOT/incoming/candidate.bundle PAYLOAD=$ROOT/incoming/runtime-files
for f in "$IDENTITY" "$BUNDLE" "$PAYLOAD/runtime-files-identity.json" "$PAYLOAD/runtime-files.sha256"; do [[ -f $f && ! -L $f ]]; done
jq -e --arg base "$BASE_SHA" --arg candidate "$CANDIDATE" --arg suite "$SUITE_SHA" '.format=="orl-c3-suite-transfer-v1" and .baseSha==$base and .candidateSha==$candidate and .sourceRef=="refs/heads/feat/trusted-verification-suite" and .suiteManifestSha256==$suite and .suiteFileCount==116' "$IDENTITY" >/dev/null
[[ $(sha256sum "$BUNDLE" | cut -d' ' -f1) == $(jq -er .bundleSha256 "$IDENTITY") && $(git bundle list-heads "$BUNDLE") == "$CANDIDATE $REF" ]]
[[ $(sha256sum "$PAYLOAD/runtime-files.sha256" | cut -d' ' -f1) == $(jq -er .payloadManifestSha256 "$IDENTITY") && $(jq -er .candidate "$PAYLOAD/runtime-files-identity.json") == "$CANDIDATE" && $(jq -er .sourceManifestSha256 "$PAYLOAD/runtime-files-identity.json") == "$SUITE_SHA" ]]
[[ -z $(find "$PAYLOAD" -type l -print -quit) && -z $(find "$PAYLOAD" ! -type f ! -type d -print -quit) ]]
while IFS= read -r row; do [[ $row =~ ^([a-f0-9]{64})\ \ ([A-Za-z0-9._/-]+)$ ]]; expected=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}; [[ $rel != *..* && $rel != /* && -f "$PAYLOAD/$rel" && ! -L "$PAYLOAD/$rel" && $(sha256sum "$PAYLOAD/$rel" | cut -d' ' -f1) == "$expected" ]]; done < "$PAYLOAD/runtime-files.sha256"
[[ ! -e $ROOT/source && ! -L $ROOT/source && ! -e $ROOT/staging/source.git && ! -L $ROOT/staging/source.git && ! -e $ROOT/staging/payload && ! -L $ROOT/staging/payload && ! -e $ROOT/staging/node && ! -L $ROOT/staging/node ]]
config=$(mktemp -d /run/orloom-c3-suite-docker.XXXXXX); chmod 0700 "$config"; cid=''
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$SOCKET" "$@"; }
cleanup(){ if [[ -n $cid ]]; then x=$(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.Running}}' "$cid" 2>/dev/null || true); if [[ $x == "$cid|/$NAME|$LABEL|$BASE|$BASE_ID|created|false" || $x == "$cid|/$NAME|$LABEL|$BASE|$BASE_ID|exited|false" ]]; then dc rm "$cid" >/dev/null; printf 'node-copy-removed\t%s\n' "$cid" >> "$ROOT/resources.tsv"; fi; fi; rm -rf -- "$config"; }
trap cleanup EXIT HUP INT TERM
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
[[ $(dc image inspect --format '{{.Id}}' "$BASE") == "$BASE_ID" && -z $(dc ps -a --filter "name=^/$NAME$" --format '{{.ID}}') ]]
mkdir -m 0700 "$ROOT/staging/source.git" "$ROOT/staging/payload"; cp -a -- "$PAYLOAD/." "$ROOT/staging/payload/"
g(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"; }
g init --bare "$ROOT/staging/source.git" >/dev/null
g --git-dir="$ROOT/staging/source.git" bundle verify "$BUNDLE" >/dev/null
g -c core.hooksPath=/dev/null --git-dir="$ROOT/staging/source.git" fetch --no-recurse-submodules "$BUNDLE" "$REF:refs/heads/candidate" >/dev/null
[[ $(g --git-dir="$ROOT/staging/source.git" rev-parse refs/heads/candidate) == "$CANDIDATE" ]]; g --git-dir="$ROOT/staging/source.git" merge-base --is-ancestor "$BASE_SHA" refs/heads/candidate
[[ ! -e $ROOT/staging/source.git/objects/info/alternates && ! -L $ROOT/staging/source.git/objects/info/alternates && ! -e $ROOT/staging/source.git/shallow && ! -L $ROOT/staging/source.git/shallow ]]
[[ -z $(g --git-dir="$ROOT/staging/source.git" ls-tree -r refs/heads/candidate | awk '$1=="160000" {print; exit') ]]
[[ -z $(g --git-dir="$ROOT/staging/source.git" config --local --get-regexp '^(core\.hooksPath|filter\.|extensions\.partialClone|remote\..*\.promisor)' || true) ]]
install -d -m 0700 "$ROOT/source"; g init "$ROOT/source" >/dev/null
g -c core.hooksPath=/dev/null -c core.autocrlf=false --git-dir="$ROOT/source/.git" --work-tree="$ROOT/source" fetch --no-recurse-submodules "$ROOT/staging/source.git" refs/heads/candidate:refs/remotes/proof/candidate >/dev/null
g -c core.hooksPath=/dev/null -c core.autocrlf=false --git-dir="$ROOT/source/.git" --work-tree="$ROOT/source" checkout --force -B feat/trusted-verification-suite refs/remotes/proof/candidate >/dev/null
[[ $(g -C "$ROOT/source" rev-parse HEAD) == "$CANDIDATE" && $(g -C "$ROOT/source" rev-parse "$REF^{commit}") == "$CANDIDATE" && -z $(g -C "$ROOT/source" status --porcelain=v1) ]]
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$SUITE_SHA" ]]
manifest=$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256
[[ -f $manifest && ! -L $manifest && $(sha256sum "$manifest" | cut -d' ' -f1) == "$SUITE_SHA" && $(wc -l < "$manifest") == 116 ]]
while IFS= read -r row; do [[ $row =~ ^([a-f0-9]{64})\ \ ([A-Za-z0-9._/-]+)$ ]]; expected=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}; [[ $rel != *..* && $rel != /* && -f "$ROOT/source/$rel" && ! -L "$ROOT/source/$rel" && $(sha256sum "$ROOT/source/$rel" | cut -d' ' -f1) == "$expected" ]]; done < "$manifest"
[[ ! -e $ROOT/source/dist && ! -L $ROOT/source/dist && ! -e $ROOT/source/node_modules && ! -L $ROOT/source/node_modules ]]
cp -a -- "$ROOT/staging/payload/dist" "$ROOT/source/dist"; cp -a -- "$ROOT/staging/payload/node_modules" "$ROOT/source/node_modules"
[[ -f $ROOT/source/dist/packages/learning/src/lesson-policy.js && -f $ROOT/source/dist/packages/stuck-resolver/src/recovery.js && -f $ROOT/source/node_modules/pg/package.json ]]
cid=$(dc create --pull=never --name "$NAME" --label "orloom.packet=$LABEL" --network none --read-only --entrypoint=/bin/sh "$BASE" -ec 'sleep 3600')
[[ $cid =~ ^[a-f0-9]{64}$ ]]; printf 'node-copy\t%s\n' "$cid" >> "$ROOT/resources.tsv"
[[ $(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.Running}}' "$cid") == "$cid|/$NAME|$LABEL|$BASE|$BASE_ID|created|false" ]]
dc cp "$cid:/root/.nvm/versions/node/v24.15.0/bin/node" "$ROOT/staging/node"
[[ -f $ROOT/staging/node && ! -L $ROOT/staging/node && $(sha256sum "$ROOT/staging/node" | cut -d' ' -f1) == "$NODE_SHA" ]]; chmod 0500 "$ROOT/staging/node"
printf 'candidate=%s\nbase=%s\nsuite_manifest=%s\nbundle=%s\npayload=%s\nnode=%s\n' "$CANDIDATE" "$BASE_SHA" "$SUITE_SHA" "$(jq -r .bundleSha256 "$IDENTITY")" "$(jq -r .payloadManifestSha256 "$IDENTITY")" "$NODE_SHA" > "$ROOT/staging/staging-identity.txt"; chmod 0400 "$ROOT/staging/staging-identity.txt"
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
echo "runtime_stage=PASS candidate=$CANDIDATE suite_files=116 bundle=$(jq -r .bundleSha256 "$IDENTITY") node_sha256=$NODE_SHA node_container_never_started=true"
