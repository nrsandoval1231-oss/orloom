#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker S=unix:///var/run/docker.sock L=ORL-C3-PROOF PREFIX=orloom-c3-proof-20261013
readonly ROOT=/var/lib/orloom/c3-proof-20261013 STAGING=/var/lib/orloom/c3-proof-20261013/staging BASE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly BASEID=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304 NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
readonly EXPECTED_CANDIDATE=765943eae18c09aa882e52c7f5255dd776c5fd43 EXPECTED_MANIFEST=91c672bd6519df3ef6344878cb75ddd81eb9285c9ad15f5528c85710ad89a211
readonly NODE_COPY_NAME=$PREFIX-node-copy
[[ $EUID -eq 0 && $# -eq 3 && $1 == prepare && $2 =~ ^[a-f0-9]{40}$ && $3 =~ ^[a-f0-9]{64}$ && -d $STAGING && ! -L $STAGING ]]
readonly EXPECTED_SHA=$2 EXPECTED_SOURCE_MANIFEST=$3
[[ $EXPECTED_SHA == "$EXPECTED_CANDIDATE" && $EXPECTED_SOURCE_MANIFEST == "$EXPECTED_MANIFEST" ]]
config=$(mktemp -d /run/orloom-c3-docker.XXXXXX); chmod 0700 "$config"; cid=''
cleanup(){
  if [[ -n $cid ]]; then
    x=$(env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.Running}}' "$cid" 2>/dev/null || true)
    if [[ $x == "$cid|/$NODE_COPY_NAME|$L|$BASE|$BASEID|created|false" || $x == "$cid|/$NODE_COPY_NAME|$L|$BASE|$BASEID|exited|false" ]]; then
      if env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" rm "$cid" >/dev/null 2>&1; then printf 'node-copy-removed\t%s\n' "$cid" >> "$ROOT/resources.tsv"; fi
    fi
  fi
  rm -rf -- "$config"
}
trap cleanup EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" "$@"; }
[[ $(dc image inspect --format '{{.Id}}' "$BASE") == "$BASEID" ]]
identity="$ROOT/incoming/payload-identity.json"; manifest="$ROOT/incoming/payload-manifest.sha256"; bundle="$ROOT/incoming/candidate.bundle"
for f in "$identity" "$manifest" "$bundle"; do [[ -f $f && ! -L $f ]]; done
source_identity="$ROOT/incoming/source-identity.json"
[[ -f $source_identity && ! -L $source_identity ]]
[[ $(jq -r .candidateSha "$identity") == "$EXPECTED_SHA" && $(jq -r .sourceManifestSha256 "$identity") == "$EXPECTED_SOURCE_MANIFEST" ]]
[[ $(jq -r .candidateSha "$source_identity") == "$EXPECTED_SHA" && $(jq -r .sourceRef "$source_identity") == "$(jq -r .sourceRef "$identity")" ]]
[[ $(jq -r .repository "$source_identity") == nrsandoval1231-oss/orloom ]]
[[ $(sha256sum "$manifest" | cut -d' ' -f1) == $(jq -r .payloadManifestSha256 "$identity") ]]
[[ $(sha256sum "$bundle" | cut -d' ' -f1) == $(jq -r .bundleSha256 "$identity") ]]
[[ -z $(find "$ROOT/incoming/payload" -type l -print -quit) ]]
[[ -z $(find "$ROOT/incoming/payload" ! -type f ! -type d -print -quit) ]]
(cd "$ROOT/incoming/payload" && sha256sum --check "$manifest" >/dev/null)
[[ ! -e "$STAGING/node" && ! -L "$STAGING/node" && ! -e "$STAGING/payload" && ! -L "$STAGING/payload" && ! -e "$STAGING/source.git" && ! -L "$STAGING/source.git" && ! -e "$ROOT/source" && ! -L "$ROOT/source" ]]
[[ -f "$ROOT/resources.tsv" && ! -L "$ROOT/resources.tsv" ]]
[[ -z $(dc ps -a --filter "name=^$NODE_COPY_NAME$" -q) ]]
cid=$(dc create --pull=never --name "$NODE_COPY_NAME" --label "orloom.packet=$L" --network none --read-only --entrypoint=/bin/sh "$BASE" -ec 'sleep 3600')
[[ $cid =~ ^[a-f0-9]{64}$ ]]
cidfile="$ROOT/node-copy-container-$cid.id"; [[ ! -e "$cidfile" && ! -L "$cidfile" ]]
printf '%s\n' "$cid" > "$cidfile"; chmod 0600 "$cidfile"
printf 'node-copy\t%s\n' "$cid" >> "$ROOT/resources.tsv"
[[ $(dc inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "orloom.packet"}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.Running}}' "$cid") == "$cid|/$NODE_COPY_NAME|$L|$BASE|$BASEID|created|false" ]]
dc cp "$cid:/root/.nvm/versions/node/v24.15.0/bin/node" "$STAGING/node"; chmod 0500 "$STAGING/node"
[[ $(sha256sum "$STAGING/node" | cut -d' ' -f1) == "$NODE_SHA" ]]
dc rm "$cid" >/dev/null; printf 'node-copy-removed\t%s\n' "$cid" >> "$ROOT/resources.tsv"; cid=''
cp -a "$ROOT/incoming/payload" "$STAGING/payload"
cp "$manifest" "$STAGING/payload-manifest.sha256"; cp "$identity" "$STAGING/payload-identity.json"; cp "$bundle" "$STAGING/candidate.bundle"
g(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"; }
g init --bare "$STAGING/source.git" >/dev/null
ref=$(jq -r .sourceRef "$identity"); candidate=$(jq -r .candidateSha "$identity"); base=$(jq -r .baseSha "$identity")
[[ $(g bundle list-heads "$STAGING/candidate.bundle") == "$candidate $ref" ]]
g -c core.hooksPath=/dev/null --git-dir="$STAGING/source.git" fetch --no-recurse-submodules "$STAGING/candidate.bundle" "$ref:refs/heads/candidate" >/dev/null
[[ $(g --git-dir="$STAGING/source.git" rev-parse refs/heads/candidate) == "$candidate" ]]
g --git-dir="$STAGING/source.git" merge-base --is-ancestor "$base" refs/heads/candidate
[[ ! -e "$STAGING/source.git/objects/info/alternates" && ! -L "$STAGING/source.git/objects/info/alternates" && ! -e "$STAGING/source.git/shallow" && ! -L "$STAGING/source.git/shallow" ]]
[[ -z $(g --git-dir="$STAGING/source.git" config --local --get-regexp '^(core\.hooksPath|filter\.|extensions\.partialClone|remote\..*\.promisor)' || true) ]]
[[ -z $(g --git-dir="$STAGING/source.git" ls-tree -r refs/heads/candidate | awk '$1=="160000" {print; exit}') ]]
install -d -m 0700 "$ROOT/source"
g init "$ROOT/source" >/dev/null
g -c core.hooksPath=/dev/null -c core.autocrlf=false --git-dir="$ROOT/source/.git" --work-tree="$ROOT/source" fetch --no-recurse-submodules "$STAGING/source.git" refs/heads/candidate:refs/remotes/proof/candidate >/dev/null
g -c core.hooksPath=/dev/null -c core.autocrlf=false --git-dir="$ROOT/source/.git" --work-tree="$ROOT/source" checkout --force -B "${ref#refs/heads/}" refs/remotes/proof/candidate >/dev/null
[[ $(g -C "$ROOT/source" rev-parse HEAD) == "$candidate" && $(g -C "$ROOT/source" rev-parse "${ref}^{commit}") == "$candidate" ]]
[[ -z $(g -C "$ROOT/source" status --porcelain=v1) ]]
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-MANIFEST.sha256" | cut -d' ' -f1) == "$EXPECTED_SOURCE_MANIFEST" ]]
while IFS= read -r row; do
  [[ $row =~ ^([a-f0-9]{64})\ \ ([A-Za-z0-9._/-]+)$ ]]
  expected_hash=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}
  [[ $rel != /* && $rel != *..* && -f "$ROOT/source/$rel" && ! -L "$ROOT/source/$rel" ]]
  [[ $(sha256sum "$ROOT/source/$rel" | cut -d' ' -f1) == "$expected_hash" ]]
done < "$ROOT/source/.agent/ORL-C3-MANIFEST.sha256"
printf 'source=%s\nbundle=%s\npayload=%s\nnode=%s\n' "$candidate" "$(jq -r .bundleSha256 "$identity")" "$(jq -r .payloadManifestSha256 "$identity")" "$NODE_SHA" > "$STAGING/staging-identity.txt"; chmod 0600 "$STAGING/staging-identity.txt"
echo "payload_stage=PASS candidate=$candidate bundle=$(jq -r .bundleSha256 "$identity") node_sha256=$NODE_SHA"
