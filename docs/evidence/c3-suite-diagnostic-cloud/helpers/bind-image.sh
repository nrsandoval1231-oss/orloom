#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-diagnostic-20261013 INCOMING=/var/lib/orloom/c3-suite-diagnostic-20261013.incoming
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 ]] || { echo 'usage: root bind-image.sh' >&2; exit 64; }
[[ -f $ROOT/stage-bindings.json && ! -L $ROOT/stage-bindings.json && -f $ROOT/verifier-image.id && ! -L $ROOT/verifier-image.id && -f $INCOMING/diagnostic-bindings.json && ! -L $INCOMING/diagnostic-bindings.json && ! -e $ROOT/bindings.json ]] || { echo 'staged binding, image identity, or final binding is unavailable' >&2; exit 66; }
jq -e 'type == "object" and (keys | sort) == ["approvedRef","baseSha","candidateSha","image","imageDigest","protectedContainerId","runtimePayloadSha256","sourceManifestSha256"] and (.baseSha|test("^[a-f0-9]{40}$")) and (.candidateSha|test("^[a-f0-9]{40}$")) and (.approvedRef|test("^refs/(heads|tags)/[A-Za-z0-9._/-]+$") and (contains("..")|not)) and (.sourceManifestSha256|test("^[a-f0-9]{64}$")) and (.runtimePayloadSha256|test("^[a-f0-9]{64}$")) and (.image|test("^sha256:[a-f0-9]{64}$")) and (.imageDigest|test("^[a-f0-9]{64}$")) and (.protectedContainerId|test("^[a-f0-9]{64}$"))' "$INCOMING/diagnostic-bindings.json" >/dev/null
for field in baseSha candidateSha approvedRef sourceManifestSha256 runtimePayloadSha256; do [[ $(jq -r ".$field" "$ROOT/stage-bindings.json") == $(jq -r ".$field" "$INCOMING/diagnostic-bindings.json") ]] || { echo "final binding differs in $field" >&2; exit 65; }; done
image=$(cat "$ROOT/verifier-image.id"); [[ $image == $(jq -r .image "$INCOMING/diagnostic-bindings.json") && ${image#sha256:} == $(jq -r .imageDigest "$INCOMING/diagnostic-bindings.json") ]] || { echo 'final binding image differs from measured image' >&2; exit 65; }
install -m 0400 "$INCOMING/diagnostic-bindings.json" "$ROOT/bindings.json"
