#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-diagnostic-20261013
readonly INCOMING=$ROOT.incoming
readonly OLD_NODE=/var/lib/orloom/c3-suite-proof-20261013/staging/node
readonly NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 ]] || { echo 'usage: root stage-diagnostic.sh' >&2; exit 64; }
[[ ! -e $ROOT && ! -L $ROOT ]] || { echo 'diagnostic root already exists; refusing overwrite' >&2; exit 73; }
[[ -d /var/lib/orloom && ! -L /var/lib/orloom ]] || { echo 'trusted parent is unavailable' >&2; exit 69; }
[[ -f $OLD_NODE && ! -L $OLD_NODE && $(sha256sum "$OLD_NODE" | cut -d' ' -f1) == "$NODE_SHA" ]] || { echo 'previous pinned Node binary is unavailable or differs' >&2; exit 69; }
[[ -d $INCOMING && ! -L $INCOMING ]] || { echo 'sibling upload directory is unavailable' >&2; exit 66; }
for f in candidate.bundle candidate-identity.json stage-bindings.json run-diagnostic.mjs; do [[ -f "$INCOMING/$f" && ! -L "$INCOMING/$f" ]] || { echo "missing incoming $f" >&2; exit 66; }; done
[[ -d $INCOMING/runtime-files && ! -L $INCOMING/runtime-files && -f $INCOMING/runtime-files/runtime-files.sha256 && ! -L $INCOMING/runtime-files/runtime-files.sha256 && -f $INCOMING/runtime-files/runtime-files-identity.json && ! -L $INCOMING/runtime-files/runtime-files-identity.json ]] || { echo 'runtime payload is incomplete' >&2; exit 66; }
jq -e 'type == "object" and (keys | sort) == ["approvedRef","baseSha","candidateSha","runtimePayloadSha256","sourceManifestSha256"] and (.baseSha|test("^[a-f0-9]{40}$")) and (.candidateSha|test("^[a-f0-9]{40}$")) and (.approvedRef|test("^refs/(heads|tags)/[A-Za-z0-9._/-]+$") and (contains("..")|not)) and (.sourceManifestSha256|test("^[a-f0-9]{64}$")) and (.runtimePayloadSha256|test("^[a-f0-9]{64}$"))' "$INCOMING/stage-bindings.json" >/dev/null
base=$(jq -r .baseSha "$INCOMING/stage-bindings.json"); candidate=$(jq -r .candidateSha "$INCOMING/stage-bindings.json"); ref=$(jq -r .approvedRef "$INCOMING/stage-bindings.json"); manifest=$(jq -r .sourceManifestSha256 "$INCOMING/stage-bindings.json"); payload=$(jq -r .runtimePayloadSha256 "$INCOMING/stage-bindings.json")
[[ $(sha256sum "$INCOMING/runtime-files/runtime-files.sha256" | cut -d' ' -f1) == "$payload" ]] || { echo 'runtime payload manifest differs from binding' >&2; exit 65; }
(cd "$INCOMING/runtime-files" && sha256sum --check runtime-files.sha256 >/dev/null)
[[ -z $(find -P "$INCOMING/runtime-files" -type l -print -quit) && -z $(find -P "$INCOMING/runtime-files" ! -type d ! -type f -print -quit) ]] || { echo 'runtime payload contains unsafe entry type' >&2; exit 65; }
runtime_expected=$( { awk '/^[a-f0-9]{64}  / { print substr($0, 67) }' "$INCOMING/runtime-files/runtime-files.sha256"; printf '%s\n' runtime-files.sha256 runtime-files-identity.json; } | LC_ALL=C sort)
runtime_actual=$(find -P "$INCOMING/runtime-files" -type f -printf '%P\n' | LC_ALL=C sort)
[[ $runtime_actual == "$runtime_expected" ]] || { echo 'runtime payload inventory differs from manifest' >&2; exit 65; }
runtime_count=$(wc -l < "$INCOMING/runtime-files/runtime-files.sha256")
jq -e --arg candidate "$candidate" --arg manifest "$manifest" --arg payload "$payload" --argjson count "$runtime_count" 'type == "object" and (keys | sort) == ["candidate","fileCount","format","payloadManifestSha256","sourceManifestSha256"] and .format == "orloom-c3-diagnostic-runtime-v1" and .candidate == $candidate and .sourceManifestSha256 == $manifest and .payloadManifestSha256 == $payload and .fileCount == $count' "$INCOMING/runtime-files/runtime-files-identity.json" >/dev/null
bundle_sha=$(sha256sum "$INCOMING/candidate.bundle" | cut -d' ' -f1)
jq -e --arg base "$base" --arg candidate "$candidate" --arg ref "$ref" --arg manifest "$manifest" --arg bundle "$bundle_sha" '.format == "orl-c3-suite-transfer-v1" and .baseSha == $base and .candidateSha == $candidate and .sourceRef == $ref and .suiteManifestSha256 == $manifest and .bundleSha256 == $bundle' "$INCOMING/candidate-identity.json" >/dev/null
install -d -m 0700 "$ROOT" "$ROOT/evidence" "$ROOT/staging"
env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git clone --bare --no-local "$INCOMING/candidate.bundle" "$ROOT/source.git" >/dev/null
gitc(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git --git-dir="$ROOT/source.git" "$@"; }
[[ $(gitc rev-parse "$ref^{commit}") == "$candidate" ]] && gitc merge-base --is-ancestor "$base" "$candidate"
[[ $(gitc rev-parse --is-bare-repository) == true && ! -e $ROOT/source.git/objects/info/alternates && ! -e $ROOT/source.git/shallow ]] || { echo 'staged object store is not complete and self-contained' >&2; exit 65; }
env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git clone --no-checkout "$ROOT/source.git" "$ROOT/source" >/dev/null
env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -C "$ROOT/source" checkout --detach "$candidate" >/dev/null
[[ -z $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT/source" status --porcelain=v1) ]] || { echo 'materialized source is not clean' >&2; exit 65; }
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$manifest" ]] || { echo 'source manifest differs from binding' >&2; exit 65; }
while IFS= read -r row; do
  [[ $row =~ ^([a-f0-9]{64})\ \ (.+)$ ]] || { echo 'invalid source manifest row' >&2; exit 65; }
  expected=${BASH_REMATCH[1]}; relative=${BASH_REMATCH[2]}
  [[ $relative != /* && $relative != *'..'* && -f "$ROOT/source/$relative" && ! -L "$ROOT/source/$relative" && $(sha256sum "$ROOT/source/$relative" | cut -d' ' -f1) == "$expected" ]] || { echo "source manifest mismatch: $relative" >&2; exit 65; }
done < "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256"
install -m 0500 "$OLD_NODE" "$ROOT/staging/node"
install -m 0400 "$INCOMING/stage-bindings.json" "$ROOT/stage-bindings.json"
cp -a --no-preserve=ownership "$INCOMING/runtime-files" "$ROOT/runtime-files"
install -m 0400 "$INCOMING/run-diagnostic.mjs" "$ROOT/run-diagnostic.mjs"
[[ $(sha256sum "$ROOT/staging/node" | cut -d' ' -f1) == "$NODE_SHA" ]] || exit 65
[[ $(sha256sum "$ROOT/runtime-files/runtime-files.sha256" | cut -d' ' -f1) == "$payload" ]] && (cd "$ROOT/runtime-files" && sha256sum --check runtime-files.sha256 >/dev/null) || { echo 'staged runtime payload rehash failed' >&2; exit 65; }
printf 'stage=PASS\ncandidate=%s\nbase=%s\nref=%s\nsource_manifest=%s\nsource_manifest_entries=%s\npayload=%s\nnode=%s\n' "$candidate" "$base" "$ref" "$manifest" "$(wc -l < "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256")" "$payload" "$NODE_SHA" > "$ROOT/staging/identity.txt"
chmod 0400 "$ROOT/staging/identity.txt"
