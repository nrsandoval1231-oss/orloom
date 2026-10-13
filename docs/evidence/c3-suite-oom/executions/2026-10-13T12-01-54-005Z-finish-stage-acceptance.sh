#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-acceptance-20261013
readonly INCOMING=$ROOT.incoming
readonly NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
readonly EXPECTED_CANDIDATE=9ebc9d91c880be907adb4b38c3e912300bf14816
readonly EXPECTED_BASE=727de8607202307f6c45186ca11546d1fcdc338b
readonly EXPECTED_MANIFEST=a37ea16aadd4e06ca3de424e5bc607f0ce6894100c4da7211b76c0c856637ca8
readonly SOURCE_REF=refs/heads/feat/trusted-verification-suite
readonly ZERO=0000000000000000000000000000000000000000

[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 ]] || { echo 'usage: root finish-stage-acceptance.sh' >&2; exit 64; }
for p in "$ROOT" "$ROOT.incoming" "$ROOT/source" "$ROOT/source.git" "$ROOT/runtime-files" "$ROOT/staging" "$ROOT/staging/node" "$ROOT/stage-bindings.json" "$ROOT/runtime-acceptance.mjs" "$ROOT/runtime-acceptance-entry.mjs" "$ROOT/runtime-snapshot-export.mjs" "$ROOT/export-acceptance-snapshot.sh" "$ROOT/prepare-acceptance-fixtures.mjs" "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" "$ROOT/runtime-files/runtime-files.sha256" "$ROOT/runtime-files/runtime-files-identity.json"; do
  [[ -e "$p" && ! -L "$p" ]] || { echo 'partial staging tree is missing a required regular path' >&2; exit 66; }
done
[[ -d "$ROOT" && -d "$INCOMING" && -d "$ROOT/source" && -d "$ROOT/source.git" && -d "$ROOT/runtime-files" && -d "$ROOT/staging" ]] || { echo 'partial staging directories are invalid' >&2; exit 66; }
[[ ! -e "$ROOT/fixtures" && ! -L "$ROOT/fixtures" && ! -e "$ROOT/staging/identity.txt" && ! -L "$ROOT/staging/identity.txt" && ! -e "$ROOT/runtime-started.json" && ! -L "$ROOT/runtime-started.json" ]] || { echo 'fixtures, identity, or runtime marker already exists; preserve and inspect partial state' >&2; exit 75; }
[[ $(sha256sum "$ROOT/staging/node" | cut -d' ' -f1) == "$NODE_SHA" ]] || { echo 'staged Node identity differs' >&2; exit 65; }

jq -e 'type=="object" and (keys|sort)==["approvedRef","baseSha","candidateSha","fixtureHelperSha256","runtimeEntrySha256","runtimeHelperSha256","runtimePayloadSha256","runtimeSnapshotSha256","runtimeSnapshotShellSha256","sourceManifestSha256"] and .approvedRef=="refs/heads/feat/trusted-verification-suite" and .baseSha=="727de8607202307f6c45186ca11546d1fcdc338b" and .candidateSha=="9ebc9d91c880be907adb4b38c3e912300bf14816" and .sourceManifestSha256=="a37ea16aadd4e06ca3de424e5bc607f0ce6894100c4da7211b76c0c856637ca8"' "$ROOT/stage-bindings.json" >/dev/null || { echo 'staged binding is not the reviewed candidate' >&2; exit 65; }
candidate=$(jq -r .candidateSha "$ROOT/stage-bindings.json"); base=$(jq -r .baseSha "$ROOT/stage-bindings.json"); manifest=$(jq -r .sourceManifestSha256 "$ROOT/stage-bindings.json"); payload=$(jq -r .runtimePayloadSha256 "$ROOT/stage-bindings.json"); helper=$(jq -r .runtimeHelperSha256 "$ROOT/stage-bindings.json"); entry=$(jq -r .runtimeEntrySha256 "$ROOT/stage-bindings.json"); snapshot=$(jq -r .runtimeSnapshotSha256 "$ROOT/stage-bindings.json"); snapshot_shell=$(jq -r .runtimeSnapshotShellSha256 "$ROOT/stage-bindings.json"); fixture_helper=$(jq -r .fixtureHelperSha256 "$ROOT/stage-bindings.json")
[[ $(sha256sum "$ROOT/runtime-files/runtime-files.sha256" | cut -d' ' -f1) == "$payload" && $(sha256sum "$ROOT/runtime-acceptance.mjs" | cut -d' ' -f1) == "$helper" && $(sha256sum "$ROOT/runtime-acceptance-entry.mjs" | cut -d' ' -f1) == "$entry" && $(sha256sum "$ROOT/runtime-snapshot-export.mjs" | cut -d' ' -f1) == "$snapshot" && $(sha256sum "$ROOT/export-acceptance-snapshot.sh" | cut -d' ' -f1) == "$snapshot_shell" && $(sha256sum "$ROOT/prepare-acceptance-fixtures.mjs" | cut -d' ' -f1) == "$fixture_helper" ]] || { echo 'staged helper or payload binding differs' >&2; exit 65; }
(cd "$ROOT/runtime-files" && sha256sum --check runtime-files.sha256 >/dev/null)
[[ -z $(find -P "$ROOT/runtime-files" -type l -print -quit) && -z $(find -P "$ROOT/runtime-files" ! -type d ! -type f -print -quit) ]] || { echo 'runtime payload contains an unsafe entry' >&2; exit 65; }
expected=$( { awk '/^[a-f0-9]{64}  / {print substr($0,67)}' "$ROOT/runtime-files/runtime-files.sha256"; printf '%s\n' runtime-files.sha256 runtime-files-identity.json; } | LC_ALL=C sort)
actual=$(find -P "$ROOT/runtime-files" -type f -printf '%P\n' | LC_ALL=C sort)
[[ $actual == "$expected" ]] || { echo 'runtime payload inventory differs' >&2; exit 65; }
payload_count=$(wc -l < "$ROOT/runtime-files/runtime-files.sha256")
jq -e --arg candidate "$EXPECTED_CANDIDATE" --arg manifest "$EXPECTED_MANIFEST" --arg payload "$payload" --argjson count "$payload_count" 'type=="object" and (keys|sort)==["candidate","fileCount","format","payloadManifestSha256","sourceManifestSha256"] and .format=="orloom-c3-acceptance-runtime-v1" and .candidate==$candidate and .sourceManifestSha256==$manifest and .payloadManifestSha256==$payload and .fileCount==$count' "$ROOT/runtime-files/runtime-files-identity.json" >/dev/null || { echo 'runtime payload identity manifest differs' >&2; exit 65; }
[[ $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$manifest" ]] || { echo 'source manifest hash differs' >&2; exit 65; }
while IFS= read -r row; do
  [[ $row =~ ^([a-f0-9]{64})\ \ (.+)$ ]] || { echo 'source manifest row is malformed' >&2; exit 65; }
  hash=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}
  [[ $rel != /* && $rel != *'..'* && -f "$ROOT/source/$rel" && ! -L "$ROOT/source/$rel" && $(sha256sum "$ROOT/source/$rel" | cut -d' ' -f1) == "$hash" ]] || { echo 'materialized source does not match manifest' >&2; exit 65; }
done < "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256"

gitc(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git "$@"; }
[[ $(gitc -C "$ROOT/source" rev-parse HEAD) == "$candidate" && -z $(gitc -C "$ROOT/source" status --porcelain=v1) ]] || { echo 'source checkout is not exact and clean' >&2; exit 65; }
[[ $(gitc --git-dir="$ROOT/source.git" rev-parse "$SOURCE_REF^{commit}") == "$candidate" && $(gitc -C "$ROOT/source" rev-parse "refs/remotes/origin/${SOURCE_REF#refs/heads/}^{commit}") == "$candidate" ]] || { echo 'bare or origin source ref does not resolve to the reviewed candidate' >&2; exit 65; }
gitc --git-dir="$ROOT/source.git" merge-base --is-ancestor "$base" "$candidate"
[[ ! -e "$ROOT/source.git/objects/info/alternates" && ! -e "$ROOT/source.git/shallow" ]] || { echo 'source object store is not self-contained' >&2; exit 65; }
if gitc -C "$ROOT/source" show-ref --verify --quiet "$SOURCE_REF"; then echo 'local approved branch already exists; refusing ref replacement' >&2; exit 75; fi
gitc -C "$ROOT/source" update-ref "$SOURCE_REF" "$candidate" "$ZERO"
[[ $(gitc -C "$ROOT/source" rev-parse "$SOURCE_REF^{commit}") == "$candidate" ]] || { echo 'new local approved ref verification failed' >&2; exit 65; }

set +e
env -i PATH=/usr/bin:/bin HOME=/root ORLOOM_ACCEPTANCE_SOURCE_REPO="$ROOT/source" ORLOOM_ACCEPTANCE_CANDIDATE_SHA="$candidate" ORLOOM_ACCEPTANCE_BASE_SHA="$base" ORLOOM_ACCEPTANCE_SOURCE_REF="$SOURCE_REF" ORLOOM_ACCEPTANCE_FIXTURE_ROOT="$ROOT/fixtures" "$ROOT/staging/node" "$ROOT/prepare-acceptance-fixtures.mjs" >/dev/null
fixture_status=$?
set -e
(( fixture_status == 0 )) || { echo 'fixture preparation failed after staging repair; preserve partial fixture state, do not rerun blindly' >&2; exit 75; }
[[ -d "$ROOT/fixtures/objects.git" && ! -L "$ROOT/fixtures/objects.git" && -f "$ROOT/fixtures/fixtures.json" && ! -L "$ROOT/fixtures/fixtures.json" ]] || { echo 'controlled fixture outputs are incomplete' >&2; exit 75; }
jq -e --arg candidate "$candidate" --arg base "$base" --arg store "$ROOT/fixtures/objects.git" 'type=="object" and (keys|sort)==["approvedRef","baseSha","fixtures","format","objectStore","sourceCandidate","sourceRef"] and .format=="orloom-c3-suite-acceptance-fixtures-v1" and .sourceCandidate==$candidate and .baseSha==$base and .sourceRef=="refs/heads/feat/trusted-verification-suite" and .objectStore==$store and .approvedRef=="refs/heads/candidate" and (.fixtures|keys|sort)==["failing","hanging","lockMismatch"]' "$ROOT/fixtures/fixtures.json" >/dev/null || { echo 'fixture metadata schema/binding differs' >&2; exit 75; }
for fixture in failing lockMismatch hanging; do commit=$(jq -r ".fixtures.$fixture.commit" "$ROOT/fixtures/fixtures.json"); parent=$(jq -r ".fixtures.$fixture.parent" "$ROOT/fixtures/fixtures.json"); [[ $commit =~ ^[a-f0-9]{40}$ && $parent == "$candidate" && $(gitc --git-dir="$ROOT/fixtures/objects.git" merge-base "$candidate" "$commit") == "$candidate" ]] || { echo 'fixture commit ancestry differs' >&2; exit 75; }; done

count=$(wc -l < "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256")
printf 'stage=PASS\ncandidate=%s\nbase=%s\nref=%s\nsource_manifest=%s\nsource_manifest_entries=%s\npayload=%s\nnode=%s\n' "$candidate" "$base" "$SOURCE_REF" "$manifest" "$count" "$payload" "$NODE_SHA" > "$ROOT/staging/identity.txt"
chmod 0400 "$ROOT/staging/identity.txt"
echo "acceptance_stage_recovery=PASS candidate=$candidate fixture_commits=3 source_worktree_writes=none source_ref_created=true"
