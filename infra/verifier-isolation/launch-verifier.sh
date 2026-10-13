#!/usr/bin/env bash
set -euo pipefail
umask 077

# This fixed root-owned slot serializes all verifier instances on this host.
readonly DOCKER=/usr/bin/docker
readonly SOCKET=unix:///var/run/docker.sock
readonly LOCK_ROOT=/run/orloom-verifier-lock
readonly SHARED_STATE_PARENT=/var/lib/orloom
readonly STATE_ROOT=$SHARED_STATE_PARENT/verifier
readonly SLOT=$STATE_ROOT/state
readonly IMAGE=${ORLOOM_VERIFIER_IMAGE:?must set the locally pinned verifier image digest}
readonly NAME=${1:?trusted caller must provide an allocated sandbox name}
readonly POLICY=${2:?trusted caller must provide a finite policy id}
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'must run as host root' >&2; exit 64; }
[[ $# -eq 2 && $NAME =~ ^orloom-verifier-[a-f0-9-]{1,40}$ && ( $POLICY == node-validate-syntax || $POLICY == node-repo-suite-v1 ) ]] || { echo 'invalid verifier invocation' >&2; exit 64; }
[[ $IMAGE =~ ^(sha256:[a-f0-9]{64}|[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64})$ ]] || { echo 'image must be digest pinned' >&2; exit 64; }
[[ -x $DOCKER && -x /usr/bin/flock && -x /usr/bin/sync ]] || { echo 'Docker, flock or sync unavailable' >&2; exit 69; }
[[ -d /run && ! -L /run && -d /var/lib && ! -L /var/lib && -d $SHARED_STATE_PARENT && ! -L $SHARED_STATE_PARENT ]] || { echo 'trusted state parent is unsafe' >&2; exit 69; }
parent_stat=$(stat -c '%u %a' "$SHARED_STATE_PARENT") || { echo 'cannot validate shared state parent' >&2; exit 69; }
read -r parent_owner parent_mode <<<"$parent_stat"
[[ $parent_owner == 0 && $parent_mode =~ ^[0-7]{3,4}$ ]] && (( (8#$parent_mode & 0022) == 0 )) || { echo 'shared state parent must be root-owned and not group/world writable' >&2; exit 69; }
mkdir -p -- "$LOCK_ROOT" "$STATE_ROOT"
[[ -d $LOCK_ROOT && ! -L $LOCK_ROOT && -d $STATE_ROOT && ! -L $STATE_ROOT ]] || { echo 'trusted state root is unsafe' >&2; exit 69; }
chmod 0700 "$LOCK_ROOT" "$STATE_ROOT"
[[ ! -L $LOCK_ROOT/slot.lock && (! -e $LOCK_ROOT/slot.lock || -f $LOCK_ROOT/slot.lock) ]] || { echo 'lock path is unsafe' >&2; exit 69; }
exec 9>"$LOCK_ROOT/slot.lock"
/usr/bin/flock -n 9 || { echo 'verifier host slot is busy' >&2; exit 75; }
[[ -d /run/orloom-verifier-input/$NAME && ! -L /run/orloom-verifier-input/$NAME ]] || { echo 'trusted staged input missing' >&2; exit 69; }

config=$(mktemp -d /run/orloom-verifier-docker.XXXXXX)
chmod 0700 "$config"
container_id=''
cleanup_failed=0
write_slot() {
  local cid=$1 phase=$2 tmp
  tmp=$(mktemp "$STATE_ROOT/.verifier-state.XXXXXX")
  printf 'ORL-C3|%s|%s|%s|%s\n' "$NAME" "$IMAGE" "$cid" "$phase" >"$tmp"
  chmod 0600 "$tmp"
  /usr/bin/sync -f "$tmp"
  mv -f -- "$tmp" "$SLOT"
  /usr/bin/sync -f "$STATE_ROOT"
}
clear_slot() { rm -f -- "$SLOT" && /usr/bin/sync -f "$STATE_ROOT"; }
identity() { "$DOCKER" --config "$config" --host "$SOCKET" inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{index .Config.Labels "orloom.run"}}|{{.Config.Image}}' "$1"; }
reconcile_prior() {
  [[ -e $SLOT ]] || return 0
  [[ -f $SLOT && ! -L $SLOT ]] || { echo 'verifier slot record is unsafe' >&2; return 1; }
  local version prior_name prior_image prior_cid prior_phase actual
  IFS='|' read -r version prior_name prior_image prior_cid prior_phase <"$SLOT" || return 1
  [[ $version == ORL-C3 && $prior_name =~ ^orloom-verifier-[a-f0-9-]{1,40}$ && $prior_image =~ ^(sha256:[a-f0-9]{64}|[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64})$ && $prior_phase == running && $prior_cid =~ ^[a-f0-9]{64}$ ]] || { echo 'previous verifier intent is ambiguous; operator reconciliation required' >&2; return 1; }
  actual=$(identity "$prior_cid") || { echo 'previous verifier identity cannot be inspected; slot remains quarantined' >&2; return 1; }
  [[ $actual == "$prior_cid|ORL-C3|$prior_name|$prior_image" ]] || { echo 'previous verifier identity mismatch; slot remains quarantined' >&2; return 1; }
  "$DOCKER" --config "$config" --host "$SOCKET" rm --force "$prior_cid" >/dev/null || { echo 'previous verifier cleanup failed; slot remains quarantined' >&2; return 1; }
  clear_slot
}
cleanup() {
  local current
  if [[ -n $container_id ]]; then
    current=$(identity "$container_id" 2>/dev/null) || current=''
    if [[ $current == "$container_id|ORL-C3|$NAME|$IMAGE" ]]; then
      if "$DOCKER" --config "$config" --host "$SOCKET" rm --force "$container_id" >/dev/null; then clear_slot || cleanup_failed=1; else cleanup_failed=1; fi
    else
      cleanup_failed=1
    fi
  fi
  rm -rf -- "$config" || cleanup_failed=1
}
trap cleanup EXIT
reconcile_prior || exit 75

inspected=$("$DOCKER" --config "$config" --host "$SOCKET" image inspect --format '{{.Id}} {{json .RepoDigests}}' "$IMAGE" 2>/dev/null) || { echo 'pinned image is not preloaded' >&2; exit 69; }
if [[ $IMAGE =~ ^sha256: ]]; then [[ ${inspected%% *} == "$IMAGE" ]] || { echo 'local image ID did not match configured digest' >&2; exit 69; }
else [[ $inspected == *"$IMAGE"* ]] || { echo 'repository digest did not match inspected image' >&2; exit 69; }
fi
name_matches=$("$DOCKER" --config "$config" --host "$SOCKET" ps --all --quiet --no-trunc --filter "name=^/${NAME}$") || { echo 'cannot establish sandbox name availability' >&2; exit 69; }
[[ -z $name_matches ]] || { echo 'sandbox name already exists; refusing to touch it' >&2; exit 69; }
write_slot '' creating
container_id=$("$DOCKER" --config "$config" --host "$SOCKET" create --interactive --pull=never \
  --name "$NAME" --label=orloom.packet=ORL-C3 --label="orloom.run=$NAME" --runtime=runsc --network=none --read-only --user=65532:65532 \
  --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit="$([[ $POLICY == node-repo-suite-v1 ]] && echo 128 || echo 64)" --memory="$([[ $POLICY == node-repo-suite-v1 ]] && echo 1g || echo 256m)" \
  --memory-swap="$([[ $POLICY == node-repo-suite-v1 ]] && echo 1g || echo 256m)" --cpus="$([[ $POLICY == node-repo-suite-v1 ]] && echo 1 || echo 0.5)" --env="ORLOOM_CHECK_POLICY=$POLICY" \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700 \
  --tmpfs="/work:rw,exec,nosuid,nodev,size=$([[ $POLICY == node-repo-suite-v1 ]] && echo 512m || echo 32m),uid=65532,gid=65532,mode=0700" \
  --entrypoint=/bin/sh "$IMAGE" -ec 'tar -xf - -C /work && cd /work/source && exec /usr/local/bin/node /opt/orloom-verifier/run-check.js')
[[ $container_id =~ ^[a-f0-9]{64}$ ]] || { container_id=''; echo 'Docker returned an invalid container ID; slot remains quarantined' >&2; exit 70; }
write_slot "$container_id" running
created=$(identity "$container_id")
[[ $created == "$container_id|ORL-C3|$NAME|$IMAGE" ]] || { echo 'created container identity did not match this invocation' >&2; exit 70; }
set +e
attach_timeout=$([[ $POLICY == node-repo-suite-v1 ]] && echo 210s || echo 60s)
tar -C "/run/orloom-verifier-input/$NAME" -cf - . | timeout --signal=TERM --kill-after=2s "$attach_timeout" "$DOCKER" --config "$config" --host "$SOCKET" start --attach --interactive "$container_id"
pipeline_status=("${PIPESTATUS[@]}")
set -e
start_status=${pipeline_status[1]}
if (( pipeline_status[0] != 0 )); then start_status=70; fi
cleanup
trap - EXIT
if (( cleanup_failed != 0 )); then echo 'verifier cleanup uncertain; slot remains quarantined' >&2; exit 70; fi
exit "$start_status"
