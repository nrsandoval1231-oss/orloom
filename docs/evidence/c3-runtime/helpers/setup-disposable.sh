#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker S=unix:///var/run/docker.sock L=ORL-C3-PROOF PREFIX=orloom-c3-proof-20261013
readonly NET=$PREFIX-net DB=$PREFIX-db INIT=$PREFIX-seed DATA=$PREFIX-data SECRET=$PREFIX-secrets PG=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly ROOT=/var/lib/orloom/c3-proof-20261013 PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
[[ $EUID -eq 0 && $# -eq 2 && $1 == prepare && $2 == /* && -f $2 && ! -L $2 && ! -e $ROOT && ! -L $ROOT ]]
[[ -d /var/lib/orloom && ! -L /var/lib/orloom && $(stat -c '%u' /var/lib/orloom) == 0 ]]
parent_mode=$(stat -c '%a' /var/lib/orloom); (( (8#$parent_mode & 0022) == 0 ))
if [[ -e /var/lib/orloom/verifier || -L /var/lib/orloom/verifier ]]; then
  [[ -d /var/lib/orloom/verifier && ! -L /var/lib/orloom/verifier && $(stat -c '%u' /var/lib/orloom/verifier) == 0 ]]
  verifier_mode=$(stat -c '%a' /var/lib/orloom/verifier); (( (8#$verifier_mode & 0022) == 0 ))
fi
if [[ -e /var/lib/orloom/verifier/state || -L /var/lib/orloom/verifier/state ]]; then [[ -f /var/lib/orloom/verifier/state && ! -L /var/lib/orloom/verifier/state && ! -s /var/lib/orloom/verifier/state ]]; fi
[[ -d /run && ! -L /run && $(stat -c '%u' /run) == 0 ]]
run_mode=$(stat -c '%a' /run); (( (8#$run_mode & 0022) == 0 ))
if [[ ! -e /run/orloom-verifier-lock && ! -L /run/orloom-verifier-lock ]]; then install -d -o root -g root -m 0700 /run/orloom-verifier-lock; fi
[[ -d /run/orloom-verifier-lock && ! -L /run/orloom-verifier-lock && $(stat -c '%u' /run/orloom-verifier-lock) == 0 ]]
lock_mode=$(stat -c '%a' /run/orloom-verifier-lock); (( (8#$lock_mode & 0022) == 0 ))
if [[ ! -e /run/orloom-verifier-lock/slot.lock && ! -L /run/orloom-verifier-lock/slot.lock ]]; then install -o root -g root -m 0600 /dev/null /run/orloom-verifier-lock/slot.lock; fi
[[ -f /run/orloom-verifier-lock/slot.lock && ! -L /run/orloom-verifier-lock/slot.lock && $(stat -c '%u' /run/orloom-verifier-lock/slot.lock) == 0 ]]
/usr/bin/flock -n /run/orloom-verifier-lock/slot.lock /bin/true
jq -e '.hostMutation == false and .runscRegistered == true and .proposedSandbox.concurrency == 1 and .verification.fullCi == false' "$2" >/dev/null
read -r memory_available < <(awk '/MemAvailable:/ {print $2*1024}' /proc/meminfo)
read -r disk_available < <(df -B1 --output=avail /var/lib | tail -n1)
(( memory_available >= 1073741824 && disk_available >= 4294967296 )) || { echo 'current one-check resource headroom is below the reviewed floor' >&2; exit 69; }
config=$(mktemp -d /run/orloom-c3-docker.XXXXXX); chmod 0700 "$config"
trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$S" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
for n in "$DB" "$INIT"; do [[ -z $(dc ps -a --filter "name=^$n$" -q) ]]; done
[[ -z $(dc network ls --filter "name=^$NET$" -q) && -z $(dc volume ls --filter "name=^$DATA$" -q) && -z $(dc volume ls --filter "name=^$SECRET$" -q) ]]
[[ $(dc image inspect --format '{{.Id}}' "$PG") == sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 ]]
install -d -m 0700 "$ROOT/incoming" "$ROOT/staging" "$ROOT/evidence" "$ROOT/artifacts"; install -m 0600 /dev/null "$ROOT/resources.tsv"
cp "$2" "$ROOT/capacity-evidence.json"; chmod 0400 "$ROOT/capacity-evidence.json"
jq -n --argjson memoryAvailableBytes "$memory_available" --argjson diskAvailableBytes "$disk_available" --arg preflightSha256 "$(sha256sum "$ROOT/capacity-evidence.json" | cut -d' ' -f1)" '{observedAtUtc:(now|todateiso8601),preflightSha256:$preflightSha256,current:{memoryAvailableBytes:$memoryAvailableBytes,diskAvailableBytes:$diskAvailableBytes},oneCheck:true}' > "$ROOT/setup-capacity.json"; chmod 0400 "$ROOT/setup-capacity.json"
record(){ printf '%s\t%s\n' "$1" "$2" >> "$ROOT/resources.tsv"; }
netid=$(dc network create --internal --driver bridge --label "orloom.packet=$L" "$NET"); record network "$netid"
dataid=$(dc volume create --label "orloom.packet=$L" "$DATA"); record data-volume "$dataid"
secretid=$(dc volume create --label "orloom.packet=$L" "$SECRET"); record secret-volume "$secretid"
seedid=$(dc create --pull=never --name "$INIT" --label "orloom.packet=$L" --network none --read-only --cpus=.25 --memory=128m --memory-swap=128m --pids-limit=32 --mount "type=volume,src=$SECRET,dst=/run/secrets" --entrypoint=/bin/sh "$PG" -ec '
 umask 077; chmod 0755 /run/secrets
 od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/admin
 od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/app
 chown postgres:postgres /run/secrets/admin; chown 65532:65532 /run/secrets/app
 chmod 0400 /run/secrets/admin /run/secrets/app
 p=$(cat /run/secrets/app)
 { printf "CREATE ROLE mission_app LOGIN PASSWORD '\''%s'\'';\n" "$p"; printf "ALTER DATABASE mission_proof OWNER TO mission_app;\nCREATE DATABASE mission_proof_aux OWNER mission_app;\n"; } > /run/secrets/001-create.sql
 unset p; chown postgres:postgres /run/secrets/001-create.sql; chmod 0400 /run/secrets/001-create.sql
'); record seed "$seedid"
[[ $seedid =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{.Image}}' "$seedid") == "$seedid|$L|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24" ]]
dc start --attach "$seedid" >/dev/null
[[ $(dc inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$seedid") == 'exited|0' ]]
dc inspect --format '{{json .}}' "$seedid" | jq '{Id,Image,State:{Status:.State.Status,ExitCode:.State.ExitCode},Config:{Image:.Config.Image,Labels:.Config.Labels,User:.Config.User},HostConfig:{NetworkMode:.HostConfig.NetworkMode,ReadonlyRootfs:.HostConfig.ReadonlyRootfs,Memory:.HostConfig.Memory,NanoCpus:.HostConfig.NanoCpus,PidsLimit:.HostConfig.PidsLimit,PortBindings:.HostConfig.PortBindings,Binds:.HostConfig.Binds}}' > "$ROOT/seed-container-inspect.json"; chmod 0400 "$ROOT/seed-container-inspect.json"
dc rm "$seedid" >/dev/null; record seed-removed "$seedid"
[[ -z $(dc ps -a --filter "name=^$DB$" -q) ]]
dbid=$(dc run -d --pull=never --name "$DB" --label "orloom.packet=$L" --network "$NET" --network-alias pg --restart=no --cpus=.50 --memory=512m --memory-swap=512m --pids-limit=64 --read-only --mount "type=volume,src=$DATA,dst=/var/lib/postgresql/data" --mount "type=volume,src=$SECRET,dst=/run/secrets,readonly" --mount "type=volume,src=$SECRET,dst=/docker-entrypoint-initdb.d,readonly" --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=70,gid=70,mode=3775 --health-cmd='pg_isready -U mission_admin -d mission_proof' --health-interval=2s --health-timeout=2s --health-retries=30 -e POSTGRES_PASSWORD_FILE=/run/secrets/admin -e POSTGRES_USER=mission_admin -e POSTGRES_DB=mission_proof "$PG"); record database "$dbid"
[[ $dbid =~ ^[a-f0-9]{64}$ && $(dc inspect --format '{{index .Config.Labels "orloom.packet"}}|{{.Image}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Binds}}' "$dbid") == "$L|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24|{}|null" ]]
health=starting; for _ in $(seq 1 45); do health=$(dc inspect --format '{{.State.Health.Status}}' "$dbid"); [[ $health == healthy ]] && break; [[ $health != unhealthy ]] || { echo 'database readiness failed' >&2; exit 70; }; sleep 2; done
[[ $health == healthy ]]
dc network inspect --format '{{json .}}' "$NET" | jq '{Id,Name,Labels,Internal,Containers,IPAM}' > "$ROOT/network-inspect.json"
dc volume inspect --format '{{json .}}' "$DATA" | jq '{Name,Driver,Labels,Scope,Options}' > "$ROOT/data-volume-inspect.json"
dc volume inspect --format '{{json .}}' "$SECRET" | jq '{Name,Driver,Labels,Scope,Options}' > "$ROOT/secrets-volume-inspect.json"
dc inspect --format '{{json .}}' "$dbid" | jq '{Id,Image,State,Config:{Image:.Config.Image,Labels:.Config.Labels},HostConfig:{Runtime:.HostConfig.Runtime,Memory:.HostConfig.Memory,NanoCpus:.HostConfig.NanoCpus,PidsLimit:.HostConfig.PidsLimit,PortBindings:.HostConfig.PortBindings,Binds:.HostConfig.Binds},NetworkSettings:{Networks:.NetworkSettings.Networks}}' > "$ROOT/database-inspect.json"
chmod 0600 "$ROOT"/*inspect.json
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
echo "pg_setup=READY id=$dbid network=$netid data_volume=$dataid secret_volume=$secretid image=sha256:b0f956... ports=none binds=none"
