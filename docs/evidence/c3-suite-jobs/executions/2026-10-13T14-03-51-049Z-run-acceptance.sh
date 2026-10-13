#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly ROOT=/var/lib/orloom/c3-suite-jobs-20261013 LABEL=ORL-C3-SUITE-JOBS
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock NODE_SHA=d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
readonly BINDINGS=$ROOT/stage-bindings.json
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 && -d "$ROOT" && ! -L "$ROOT" && -f "$ROOT/resources.tsv" && ! -L "$ROOT/resources.tsv" ]] || { echo 'acceptance root is unavailable or unsafe' >&2; exit 66; }
[[ ! -e "$ROOT/runtime-started.json" && ! -L "$ROOT/runtime-started.json" ]] || { echo 'an acceptance attempt was already started; preserve UNKNOWN and do not redispatch' >&2; exit 75; }
for f in "$ROOT/source" "$ROOT/runtime-files" "$ROOT/fixtures/objects.git" "$ROOT/fixtures/fixtures.json" "$ROOT/staging/database-url" "$ROOT/staging/node" "$ROOT/evidence" "$ROOT/artifacts" "$ROOT/verifier-image.id" "$ROOT/image-binding.json" "$BINDINGS" "$ROOT/runtime-acceptance.mjs" "$ROOT/cgroup-observer.mjs" "$ROOT/runtime-acceptance-entry.mjs" "$ROOT/runtime-snapshot-export.mjs" "$ROOT/prepare-acceptance-fixtures.mjs"; do [[ -e "$f" && ! -L "$f" ]] || { echo 'acceptance runtime input is missing or unsafe' >&2; exit 66; }; done
[[ -d "$ROOT/source" && -d "$ROOT/runtime-files" && -d "$ROOT/fixtures/objects.git" && -d "$ROOT/evidence" && -d "$ROOT/artifacts" ]] || { echo 'acceptance runtime directories are invalid' >&2; exit 66; }
[[ $(stat -c '%a' "$ROOT/staging/database-url") == 400 && $(stat -c '%a' "$ROOT/staging/node") == 500 && $(sha256sum "$ROOT/staging/node" | cut -d' ' -f1) == "$NODE_SHA" ]] || { echo 'database URL or pinned Node identity is invalid' >&2; exit 65; }
grep -Eq '^postgres://mission_app:[a-f0-9]{64}@[0-9.]+:5432/mission_proof$' "$ROOT/staging/database-url" || { echo 'root-only database URL file is malformed' >&2; exit 65; }
jq -e 'type=="object" and (keys|sort)==["approvedRef","baseSha","candidateSha","fixtureHelperSha256","observerHelperSha256","runtimeEntrySha256","runtimeHelperSha256","runtimePayloadSha256","runtimeSnapshotSha256","runtimeSnapshotShellSha256","sourceManifestSha256"] and (.candidateSha|test("^[a-f0-9]{40}$")) and (.baseSha|test("^[a-f0-9]{40}$")) and (.approvedRef|test("^refs/heads/[A-Za-z0-9._/-]+$") and (contains("..")|not)) and (.sourceManifestSha256|test("^[a-f0-9]{64}$")) and (.runtimePayloadSha256|test("^[a-f0-9]{64}$")) and (.runtimeHelperSha256|test("^[a-f0-9]{64}$")) and (.observerHelperSha256|test("^[a-f0-9]{64}$")) and (.runtimeEntrySha256|test("^[a-f0-9]{64}$")) and (.runtimeSnapshotSha256|test("^[a-f0-9]{64}$")) and (.runtimeSnapshotShellSha256|test("^[a-f0-9]{64}$")) and (.fixtureHelperSha256|test("^[a-f0-9]{64}$"))' "$BINDINGS" >/dev/null || { echo 'stage binding schema is invalid' >&2; exit 65; }
candidate=$(jq -r .candidateSha "$BINDINGS"); base=$(jq -r .baseSha "$BINDINGS"); ref=$(jq -r .approvedRef "$BINDINGS"); manifest=$(jq -r .sourceManifestSha256 "$BINDINGS"); payload=$(jq -r .runtimePayloadSha256 "$BINDINGS")
helper=$(jq -r .runtimeHelperSha256 "$BINDINGS"); observer=$(jq -r .observerHelperSha256 "$BINDINGS"); entry=$(jq -r .runtimeEntrySha256 "$BINDINGS"); exporter=$(jq -r .runtimeSnapshotSha256 "$BINDINGS"); exporter_shell=$(jq -r .runtimeSnapshotShellSha256 "$BINDINGS"); fixture_helper=$(jq -r .fixtureHelperSha256 "$BINDINGS")
gitc(){ env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git -C "$ROOT/source" "$@"; }
[[ $(gitc rev-parse HEAD) == "$candidate" && $(gitc rev-parse "$ref^{commit}") == "$candidate" && -z $(gitc status --porcelain=v1) && $(sha256sum "$ROOT/source/.agent/ORL-C3-SUITE-MANIFEST.sha256" | cut -d' ' -f1) == "$manifest" ]] || { echo 'staged source identity is not exact and clean' >&2; exit 65; }
[[ $(sha256sum "$ROOT/runtime-acceptance.mjs" | cut -d' ' -f1) == "$helper" && $(sha256sum "$ROOT/cgroup-observer.mjs" | cut -d' ' -f1) == "$observer" && $(sha256sum "$ROOT/runtime-acceptance-entry.mjs" | cut -d' ' -f1) == "$entry" && $(sha256sum "$ROOT/runtime-snapshot-export.mjs" | cut -d' ' -f1) == "$exporter" && $(sha256sum "$ROOT/export-acceptance-snapshot.sh" | cut -d' ' -f1) == "$exporter_shell" && $(sha256sum "$ROOT/prepare-acceptance-fixtures.mjs" | cut -d' ' -f1) == "$fixture_helper" && $(sha256sum "$ROOT/runtime-files/runtime-files.sha256" | cut -d' ' -f1) == "$payload" ]] || { echo 'runtime helper/payload binding differs' >&2; exit 65; }
(cd "$ROOT/runtime-files" && sha256sum --check runtime-files.sha256 >/dev/null) || { echo 'runtime payload inventory differs' >&2; exit 65; }
[[ -f "$ROOT/runtime-files/dist/packages/contracts/src/postgres-store.js" && -f "$ROOT/runtime-files/dist/packages/contracts/src/sql-mission-store.js" && -f "$ROOT/runtime-files/dist/packages/governor/src/governor.js" && -f "$ROOT/runtime-files/dist/apps/verifier/src/index.js" && -f "$ROOT/runtime-files/node_modules/pg/package.json" && -f "$ROOT/source/db/migrations/004_verification.sql" ]] || { echo 'compiled runtime or source migrations are incomplete' >&2; exit 66; }
[[ -f "$ROOT/source/infra/verifier-isolation/launch-verifier.sh" && ! -L "$ROOT/source/infra/verifier-isolation/launch-verifier.sh" ]] || { echo 'reviewed source launcher is missing' >&2; exit 66; }
jq -e --arg candidate "$candidate" --arg base "$base" --arg store "$ROOT/fixtures/objects.git" 'type=="object" and .format=="orloom-c3-suite-acceptance-fixtures-v1" and .sourceCandidate==$candidate and .baseSha==$base and .objectStore==$store and (.approvedRef|test("^refs/heads/[A-Za-z0-9._/-]+$") and (contains("..")|not)) and (.fixtures|keys|sort)==["failing","hanging","lockMismatch"]' "$ROOT/fixtures/fixtures.json" >/dev/null || { echo 'fixture ancestry or object-store binding is invalid' >&2; exit 65; }
for fixture in failing lockMismatch hanging; do commit=$(jq -r ".fixtures.$fixture.commit" "$ROOT/fixtures/fixtures.json"); parent=$(jq -r ".fixtures.$fixture.parent" "$ROOT/fixtures/fixtures.json"); [[ $commit =~ ^[a-f0-9]{40}$ && $parent == "$candidate" && $(env -i PATH=/usr/bin:/bin HOME=/root GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git --git-dir="$ROOT/fixtures/objects.git" merge-base "$candidate" "$commit") == "$candidate" ]] || { echo 'controlled fixture ancestry is invalid' >&2; exit 65; }; done
capacity_sha=$(sha256sum "$ROOT/capacity-evidence.json" | cut -d' ' -f1); image=$(cat "$ROOT/verifier-image.id")
[[ $capacity_sha =~ ^[a-f0-9]{64}$ && $image =~ ^sha256:[a-f0-9]{64}$ && $(jq -r .candidateSha "$ROOT/image-binding.json") == "$candidate" && $(jq -r .sourceManifestSha256 "$ROOT/image-binding.json") == "$manifest" && $(jq -r .image "$ROOT/image-binding.json") == "$image" ]] || { echo 'image/capacity binding is invalid' >&2; exit 65; }
config=$(mktemp -d /run/orloom-c3-suite-acceptance-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin HOME=/root "$D" --config "$config" --host "$SOCKET" "$@"; }
protected_now=$(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal); [[ $protected_now == "$PROTECTED" && $(jq -r .protectedContainer "$ROOT/capacity-evidence.json") == "$PROTECTED" ]] || { echo 'protected host container identity changed' >&2; exit 69; }
[[ $(dc image inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.candidate"}}' "$image") == "$image|ORL-C3-SUITE-JOBS|$candidate" ]] || { echo 'acceptance image identity/labels differ' >&2; exit 65; }
dbid=$(awk -F '\t' '$1=="database" {print $2}' "$ROOT/resources.tsv"); [[ $dbid =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{.State.Health.Status}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Binds}}' "$dbid") == "$dbid|ORL-C3-SUITE-JOBS|healthy|{}|null" ]] || { echo 'disposable PostgreSQL identity is not healthy and isolated' >&2; exit 69; }
[[ -d /var/lib/orloom/verifier && ! -L /var/lib/orloom/verifier && $(stat -c '%u' /var/lib/orloom/verifier) == 0 && ! -L /var/lib/orloom/verifier/state ]] || { echo 'canonical verifier state root is unsafe' >&2; exit 69; }
if [[ -e /var/lib/orloom/verifier/state ]]; then [[ -f /var/lib/orloom/verifier/state && ! -s /var/lib/orloom/verifier/state ]] || { echo 'canonical verifier state is not empty; refusing a fresh acceptance launch' >&2; exit 75; }; fi
[[ -d /run/orloom-verifier-lock && ! -L /run/orloom-verifier-lock && -f /run/orloom-verifier-lock/slot.lock && ! -L /run/orloom-verifier-lock/slot.lock ]] || { echo 'canonical verifier slot lock is unavailable or unsafe' >&2; exit 69; }
/usr/bin/flock -n /run/orloom-verifier-lock/slot.lock /bin/true >/dev/null 2>&1 || { echo 'canonical verifier slot is busy; refusing acceptance dispatch' >&2; exit 75; }
runid=$(cat /proc/sys/kernel/random/uuid); [[ $runid =~ ^[a-f0-9-]{36}$ ]] || { echo 'runtime evidence identity unavailable' >&2; exit 69; }; evidence="$ROOT/evidence/runtime-$runid"; install -d -m 0700 "$evidence"; event_since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"format":"orloom-c3-suite-acceptance-runtime-started-v1","candidateSha":"%s","sourceManifestSha256":"%s","runId":"%s","startedAt":"%s"}\n' "$candidate" "$manifest" "$runid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/runtime-started.json"; chmod 0400 "$ROOT/runtime-started.json"
set +e
(
  cd "$ROOT/source"
  env -i PATH=/usr/bin:/bin HOME=/root LANG=C ORLOOM_ACCEPTANCE_CONTROL_ROOT="$ROOT/runtime-files" \
    ORLOOM_ACCEPTANCE_RUNTIME_MODULE="$ROOT/runtime-acceptance.mjs" \
    ORLOOM_ACCEPTANCE_DATABASE_URL_FILE="$ROOT/staging/database-url" ORLOOM_ACCEPTANCE_OBJECT_STORE="$ROOT/fixtures/objects.git" \
    ORLOOM_ACCEPTANCE_BASE_SHA="$base" ORLOOM_ACCEPTANCE_CANDIDATE_SHA="$candidate" \
    ORLOOM_ACCEPTANCE_FIXTURES_FILE="$ROOT/fixtures/fixtures.json" ORLOOM_ACCEPTANCE_CAPACITY_EVIDENCE_SHA256="$capacity_sha" \
    ORLOOM_VERIFIER_IMAGE="$image" ORLOOM_VERIFIER_ID=c3-suite-acceptance \
    ORLOOM_VERIFIER_ARTIFACT_ROOT="$ROOT/artifacts" ORLOOM_ACCEPTANCE_EVIDENCE_DIR="$evidence" \
    ORLOOM_VERIFIER_LAUNCHER="$ROOT/source/infra/verifier-isolation/launch-verifier.sh" \
    ORLOOM_ACCEPTANCE_DOCKER_CONFIG="$config" "$ROOT/staging/node" "$ROOT/runtime-acceptance-entry.mjs"
) > "$evidence/runner-output.txt" 2> "$evidence/runner-error.txt"
status=$?
set -e
printf '{"runnerExitCode":%s,"candidateSha":"%s","runId":"%s"}\n' "$status" "$candidate" "$runid" > "$evidence/runner-exit.json"
profile=$(find "$evidence" -type f -name runsc-resource-profile.json -print -quit); cid=''; event_status='unavailable'
if [[ -n $profile && -f $profile && ! -L $profile ]]; then cid=$(jq -r '.observed.container.id // empty' "$profile"); fi
if [[ $cid =~ ^[a-f0-9]{64}$ ]]; then
  set +e; dc events --since "$event_since" --until "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --filter type=container --filter "container=$cid" --format '{{json .}}' > "$evidence/exact-sandbox-events.jsonl"; event_status=$?; set -e
else printf '' > "$evidence/exact-sandbox-events.jsonl"; fi
printf '{"format":"orloom-c3-exact-sandbox-events-v1","candidateSha":"%s","runId":"%s","containerId":%s,"dockerEventsExitCode":"%s"}\n' "$candidate" "$runid" "$(jq -Rn --arg cid "$cid" '$cid | if length == 64 then . else null end')" "$event_status" > "$evidence/exact-sandbox-events-meta.json"
chmod 0400 "$evidence/runner-output.txt" "$evidence/runner-error.txt" "$evidence/runner-exit.json" "$evidence/exact-sandbox-events.jsonl" "$evidence/exact-sandbox-events-meta.json"
set +e
"$ROOT/export-acceptance-snapshot.sh" > "$evidence/snapshot-export-output.txt" 2> "$evidence/snapshot-export-error.txt"
export_status=$?
set -e
chmod 0400 "$evidence/snapshot-export-output.txt" "$evidence/snapshot-export-error.txt"
[[ $export_status == 0 ]] || { echo "acceptance snapshot export failed; preserve evidence at $evidence and do not clean up" >&2; exit 75; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]] || { echo "protected host identity changed; preserve evidence at $evidence" >&2; exit 69; }
if (( status != 0 )); then echo "acceptance proof did not pass; preserve UNKNOWN/FAIL evidence at $evidence (exit=$status)" >&2; exit "$status"; fi
echo "c3_suite_acceptance=PASS evidence=$evidence candidate=$candidate snapshot=$ROOT/evidence/acceptance-snapshot.json"
