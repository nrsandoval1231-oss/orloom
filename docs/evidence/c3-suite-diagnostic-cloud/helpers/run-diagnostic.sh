#!/usr/bin/env bash
set -euo pipefail
readonly ROOT=/var/lib/orloom/c3-suite-diagnostic-20261013
[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 0 && -x $ROOT/staging/node && -f $ROOT/bindings.json && -f $ROOT/run-diagnostic.mjs ]] || { echo 'diagnostic root is incomplete' >&2; exit 66; }
readonly STATE=/var/lib/orloom/verifier/state LOCK=/run/orloom-verifier-lock/slot.lock
[[ -d /run/orloom-verifier-lock && ! -L /run/orloom-verifier-lock && (! -e $LOCK || ( -f $LOCK && ! -L $LOCK )) ]] || { echo 'shared verifier lock is unsafe' >&2; exit 75; }
[[ ! -e $STATE || ( -f $STATE && ! -L $STATE && ! -s $STATE ) ]] || { echo 'canonical verifier state is occupied or quarantined' >&2; exit 75; }
exec "$ROOT/staging/node" "$ROOT/run-diagnostic.mjs"
