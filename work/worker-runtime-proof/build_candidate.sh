#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build_candidate.sh CONTEXT_DIR SOURCE_MANIFEST_SHA256" >&2
  exit 2
fi
context=$(realpath -e -- "$1")
manifest_sha=$2
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'invalid manifest SHA-256' >&2; exit 2; }
expected_context=$(realpath -e -- "$(dirname -- "$0")/candidate-context")
[[ "$context" == "$expected_context" ]] || { echo 'context must be the prepared candidate-context directory' >&2; exit 2; }
metadata="$(dirname -- "$context")/candidate-context-proof.json"
python3 - "$context" "$metadata" "$manifest_sha" <<'PY'
import hashlib, json, pathlib, sys
root=pathlib.Path(sys.argv[1]); meta_path=pathlib.Path(sys.argv[2]); expected=sys.argv[3]
meta=json.loads(meta_path.read_text())
if meta.get('sourceManifestSha256') != expected: raise SystemExit('context manifest identity mismatch')
allowed={'Dockerfile.sandbox','dist/apps/worker/src/sandbox-entry.js'}
actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
if actual != allowed: raise SystemExit('context contains unexpected or missing files')
for rel,key in [('Dockerfile.sandbox','dockerfile'),('dist/apps/worker/src/sandbox-entry.js','compiledEntry')]:
 h=hashlib.sha256((root/rel).read_bytes()).hexdigest()
 if meta.get('files',{}).get(key) != h: raise SystemExit('context file digest mismatch')
PY
config=$(mktemp -d /tmp/orloom-proof-docker-config.XXXXXX)
case "$config" in /tmp/orloom-proof-docker-config.*) ;; *) echo 'unsafe Docker config path' >&2; exit 9 ;; esac
chmod 0700 "$config"
cleanup_config() {
  case "$config" in /tmp/orloom-proof-docker-config.*) rm -rf -- "$config" ;; *) echo 'unsafe Docker config cleanup path' >&2; return 9 ;; esac
}
trap cleanup_config EXIT
export DOCKER_CONFIG="$config" HOME=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
image="orloom-worker-sandbox-proof:${manifest_sha:0:12}"
/usr/bin/docker --config "$config" --host unix:///var/run/docker.sock build --network=none --pull=false \
  --build-arg "ORLOOM_WORKER_NODE_BASE=node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd" \
  --label "org.orloom.proof.source-manifest-sha256=$manifest_sha" \
  --label "org.orloom.proof.dockerfile-sha256=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["files"]["dockerfile"])' "$metadata")" \
  --label "org.orloom.proof.sandbox-source-sha256=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["files"]["sandboxSource"])' "$metadata")" \
  --label "org.orloom.proof.compiled-entry-sha256=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["files"]["compiledEntry"])' "$metadata")" \
  --label 'org.orloom.proof.node-base=node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd' \
  --tag "$image" --file "$context/Dockerfile.sandbox" "$context"
printf 'built_proof_image=%s\n' "$image"
