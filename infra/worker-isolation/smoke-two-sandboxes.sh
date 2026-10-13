#!/usr/bin/env bash
set -euo pipefail
readonly DOCKER=/usr/bin/docker
readonly SOCKET='unix:///var/run/docker.sock'
readonly LAUNCHER="$(cd -- "$(dirname -- "$0")" && pwd)/launch-worker-sandbox.sh"
config_dir=$(mktemp -d /run/orloom-iso-smoke-docker.XXXXXX)
chmod 0700 "$config_dir"
id_a=''; id_b=''
cleanup() {
  [[ -z $id_a ]] || "$DOCKER" --config "$config_dir" --host "$SOCKET" rm -f "$id_a" >/dev/null 2>&1 || true
  [[ -z $id_b ]] || "$DOCKER" --config "$config_dir" --host "$SOCKET" rm -f "$id_b" >/dev/null 2>&1 || true
  rm -rf -- "$config_dir"
}
trap cleanup EXIT HUP INT TERM
suffix="$(date -u +%Y%m%d%H%M%S)-$$"
id_a=$("$LAUNCHER" "orloom-worker-iso-a-$suffix")
id_b=$("$LAUNCHER" "orloom-worker-iso-b-$suffix")
INSPECT_CONFIG="$config_dir" python3 "$(dirname -- "$0")/tests/inspect_assert.py" "$id_a" "$id_b"

exec_in() { "$DOCKER" --config "$config_dir" --host "$SOCKET" exec "$1" "${@:2}"; }
[[ $(exec_in "$id_a" /usr/bin/id -u) == 65532 ]]
[[ $(exec_in "$id_b" /usr/bin/id -u) == 65532 ]]
exec_in "$id_a" /bin/sh -ec 'printf alpha > /work/alpha.marker; printf scratch-a > /tmp/scratch.marker'
exec_in "$id_b" /bin/sh -ec 'printf beta > /work/beta.marker; test ! -e /work/alpha.marker; test ! -e /tmp/scratch.marker'
exec_in "$id_a" /bin/sh -ec 'test ! -e /work/beta.marker'
if exec_in "$id_a" /bin/sh -ec 'touch /etc/orloom-rootfs-write-probe' >/dev/null 2>&1; then
  printf 'root filesystem unexpectedly writable\n' >&2; exit 1
fi
if exec_in "$id_a" /usr/bin/python3 -c 'import socket; socket.create_connection(("1.1.1.1",443),timeout=1)' >/dev/null 2>&1; then
  printf 'outbound network unexpectedly available\n' >&2; exit 1
fi
for id in "$id_a" "$id_b"; do
  exec_in "$id" /bin/sh -ec 'test ! -e /var/lib/orloom/codex/auth.json; test ! -e /root/.codex/auth.json; test ! -e /var/run/docker.sock; test ! -e /run/docker.sock'
done
printf 'sandbox_smoke=PASS concurrent=2 isolation=PASS outbound=blocked rootfs_write=blocked auth_and_socket=absent\n'
"$DOCKER" --config "$config_dir" --host "$SOCKET" stats --no-stream --format 'resource name={{.Name}} cpu={{.CPUPerc}} memory={{.MemUsage}}' "$id_a" "$id_b"
printf 'container_ids=%s,%s\n' "$id_a" "$id_b"
