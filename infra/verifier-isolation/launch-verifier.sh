#!/usr/bin/env bash
set -euo pipefail

# Trusted local launcher. Invoke only from the protected control-plane host.
readonly DOCKER=/usr/bin/docker
readonly SOCKET=unix:///var/run/docker.sock
readonly IMAGE=${ORLOOM_VERIFIER_IMAGE:?must set the locally pinned verifier image digest}
readonly NAME=${1:?trusted caller must provide an allocated sandbox name}
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'must run as host root' >&2; exit 64; }
[[ $# -eq 1 && $NAME =~ ^orloom-verifier-[a-f0-9-]{1,40}$ ]] || { echo 'invalid verifier sandbox name' >&2; exit 64; }
[[ $IMAGE =~ ^(sha256:[a-f0-9]{64}|[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64})$ ]] || { echo 'image must be digest pinned' >&2; exit 64; }
[[ -x $DOCKER ]] || { echo 'Docker CLI unavailable' >&2; exit 69; }
[[ -d /run/orloom-verifier-input/$NAME && ! -L /run/orloom-verifier-input/$NAME ]] || { echo 'trusted staged input missing' >&2; exit 69; }
config=$(mktemp -d /run/orloom-verifier-docker.XXXXXX)
chmod 0700 "$config"
container_id=''
cleanup() {
  if [[ -n $container_id ]]; then
    current=$("$DOCKER" --config "$config" --host "$SOCKET" inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.run"}}|{{.Config.Image}}' "$container_id" 2>/dev/null || true)
    if [[ $current == "$container_id|ORL-C3|$NAME|$IMAGE" ]]; then "$DOCKER" --config "$config" --host "$SOCKET" rm --force "$container_id" >/dev/null 2>&1 || true; fi
  fi
  rm -rf -- "$config"
}
trap cleanup EXIT HUP INT TERM
inspected=$("$DOCKER" --config "$config" --host "$SOCKET" image inspect --format '{{.Id}} {{json .RepoDigests}}' "$IMAGE" 2>/dev/null) || { echo 'pinned image is not preloaded' >&2; exit 69; }
if [[ $IMAGE =~ ^sha256: ]]; then [[ ${inspected%% *} == "$IMAGE" ]] || { echo 'local image ID did not match configured digest' >&2; exit 69; }
else [[ $inspected == *"$IMAGE"* ]] || { echo 'repository digest did not match inspected image' >&2; exit 69; }
fi
if "$DOCKER" --config "$config" --host "$SOCKET" inspect "$NAME" >/dev/null 2>&1; then echo 'sandbox name already exists; refusing to touch it' >&2; exit 69; fi
container_id=$("$DOCKER" --config "$config" --host "$SOCKET" create --interactive --pull=never \
  --name "$NAME" --label=orloom.packet=ORL-C3 --label="orloom.run=$NAME" --runtime=runsc --network=none --read-only --user=65532:65532 \
  --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=64 --memory=256m \
  --memory-swap=256m --cpus=0.5 \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700 \
  --tmpfs=/work:rw,exec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700 \
  --entrypoint=/bin/sh "$IMAGE" -ec 'tar -xf - -C /work && exec /usr/local/bin/node /opt/orloom-verifier/run-check.js')
[[ $container_id =~ ^[a-f0-9]{64}$ ]] || { echo 'Docker returned an invalid container ID' >&2; exit 70; }
created=$("$DOCKER" --config "$config" --host "$SOCKET" inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.run"}}|{{.Config.Image}}' "$container_id")
[[ $created == "$container_id|ORL-C3|$NAME|$IMAGE" ]] || { echo 'created container identity did not match this invocation' >&2; exit 70; }
tar -C "/run/orloom-verifier-input/$NAME" -cf - . | timeout --signal=TERM --kill-after=2s 60s "$DOCKER" --config "$config" --host "$SOCKET" start --attach --interactive "$container_id"
