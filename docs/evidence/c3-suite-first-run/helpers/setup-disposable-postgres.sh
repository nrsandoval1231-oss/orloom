#!/usr/bin/env bash
set -euo pipefail
readonly D=/usr/bin/docker SOCKET=unix:///var/run/docker.sock LABEL=ORL-C3-SUITE-PROOF PREFIX=orloom-c3-suite-proof-20261013
readonly ROOT=/var/lib/orloom/c3-suite-proof-20261013 PG=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly PROTECTED='5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67 2026-10-12T23:51:46.164222792Z 0 runc running'
readonly NET=$PREFIX-net DB=$PREFIX-db INIT=$PREFIX-seed DATA=$PREFIX-data SECRET=$PREFIX-secrets
[[ $EUID -eq 0 && $# -eq 2 && $1 == prepare && $2 == /* && -f $2 && ! -L $2 && ! -e $ROOT && ! -L $ROOT ]]
[[ -d /var/lib/orloom && ! -L /var/lib/orloom && $(stat -c '%u' /var/lib/orloom) == 0 ]]
mode=$(stat -c '%a' /var/lib/orloom); (( (8#$mode & 0022) == 0 ))
jq -e --arg protected "$PROTECTED" '.hostMutation == false and .providerCalls == 0 and .runscRegistered == true and .protectedContainer == $protected and .images.universal == "sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304" and .images.postgres == "sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"' "$2" >/dev/null
MEM_AVAILABLE=$(awk '$1=="MemAvailable:" {printf "%.0f", $2*1024}' /proc/meminfo)
DISK_AVAILABLE=$(df -PB1 /var/lib | awk 'NR==2 {print $4}')
[[ $MEM_AVAILABLE =~ ^[0-9]+$ && $DISK_AVAILABLE =~ ^[0-9]+$ && $MEM_AVAILABLE -ge 2147483648 && $DISK_AVAILABLE -ge 4294967296 ]] || { echo 'current host capacity below packet floor; no resources created' >&2; exit 75; }
config=$(mktemp -d /run/orloom-c3-suite-docker.XXXXXX); chmod 0700 "$config"; trap 'rm -rf -- "$config"' EXIT HUP INT TERM
dc(){ env -i PATH=/usr/bin:/bin "$D" --config "$config" --host "$SOCKET" "$@"; }
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
[[ $(dc image inspect --format '{{.Id}}' "$PG") == sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 ]]
for name in "$DB" "$INIT"; do [[ -z $(dc ps -a --filter "name=^/${name}$" --format '{{.ID}}') ]]; done
[[ -z $(dc network ls --filter "name=^${NET}$" --format '{{.ID}}') && -z $(dc volume ls --filter "name=^${DATA}$" --format '{{.Name}}') && -z $(dc volume ls --filter "name=^${SECRET}$" --format '{{.Name}}') ]]
install -d -m 0700 "$ROOT/incoming" "$ROOT/staging" "$ROOT/evidence" "$ROOT/artifacts"
install -m 0600 /dev/null "$ROOT/resources.tsv"
cp -- "$2" "$ROOT/capacity-evidence.json"; chmod 0400 "$ROOT/capacity-evidence.json"
readonly PREFLIGHT_SHA=$(sha256sum "$ROOT/capacity-evidence.json" | cut -d' ' -f1)
jq -n --arg sha "$PREFLIGHT_SHA" '{preflightSha256:$sha,profile:{cpu:1,memoryBytes:1073741824,pids:128,workTmpfsBytes:536870912,tempTmpfsBytes:16777216,timeoutMs:60000},oneCheck:true}' > "$ROOT/setup-capacity.json"
chmod 0400 "$ROOT/setup-capacity.json"
record(){ printf '%s\t%s\n' "$1" "$2" >> "$ROOT/resources.tsv"; }
netid=$(dc network create --internal --driver bridge --label "orloom.packet=$LABEL" "$NET"); record network "$netid"
dataid=$(dc volume create --label "orloom.packet=$LABEL" "$DATA"); record data-volume "$dataid"
secretid=$(dc volume create --label "orloom.packet=$LABEL" "$SECRET"); record secret-volume "$secretid"
seedid=$(dc create --pull=never --name "$INIT" --label "orloom.packet=$LABEL" --network none --read-only --cpus=.25 --memory=128m --memory-swap=128m --pids-limit=32 --mount "type=volume,src=$SECRET,dst=/run/secrets" --entrypoint=/bin/sh "$PG" -ec '
 umask 077; chmod 0755 /run/secrets
 od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/admin
 od -An -N32 -tx1 /dev/urandom | tr -d " \n" > /run/secrets/app
 chown postgres:postgres /run/secrets/admin; chown 65532:65532 /run/secrets/app; chmod 0400 /run/secrets/admin /run/secrets/app
 p=$(cat /run/secrets/app)
 { printf "CREATE ROLE mission_app LOGIN PASSWORD '\''%s'\'';\n" "$p"; printf "ALTER DATABASE mission_proof OWNER TO mission_app;\nCREATE DATABASE mission_proof_aux OWNER mission_app;\n"; } > /run/secrets/001-create.sql
 unset p; chown postgres:postgres /run/secrets/001-create.sql; chmod 0400 /run/secrets/001-create.sql
'); record seed "$seedid"
[[ $(dc inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{.Image}}' "$seedid") == "$seedid|$LABEL|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24" ]]
dc start --attach "$seedid" >/dev/null
[[ $(dc inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$seedid") == 'exited|0' ]]
dc rm "$seedid" >/dev/null; record seed-removed "$seedid"
dbid=$(dc run -d --pull=never --name "$DB" --label "orloom.packet=$LABEL" --network "$NET" --network-alias pg --restart=no --cpus=.50 --memory=512m --memory-swap=512m --pids-limit=64 --read-only --mount "type=volume,src=$DATA,dst=/var/lib/postgresql/data" --mount "type=volume,src=$SECRET,dst=/run/secrets,readonly" --mount "type=volume,src=$SECRET,dst=/docker-entrypoint-initdb.d,readonly" --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=70,gid=70,mode=3775 --health-cmd='pg_isready -U mission_admin -d mission_proof' --health-interval=2s --health-timeout=2s --health-retries=30 -e POSTGRES_PASSWORD_FILE=/run/secrets/admin -e POSTGRES_USER=mission_admin -e POSTGRES_DB=mission_proof "$PG"); record database "$dbid"
[[ $(dc inspect --format '{{.Id}}|{{index .Config.Labels "orloom.packet"}}|{{.Image}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Binds}}' "$dbid") == "$dbid|$LABEL|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24|{}|null" ]]
health=starting; for _ in $(seq 1 45); do health=$(dc inspect --format '{{.State.Health.Status}}' "$dbid"); [[ $health == healthy ]] && break; [[ $health != unhealthy ]] || { echo 'database health check failed' >&2; exit 70; }; sleep 2; done
[[ $health == healthy ]]
ip=$(dc inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$dbid"); [[ $ip =~ ^(10\.[0-9]+\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)$ ]]
app_password=$(dc exec "$DB" cat /run/secrets/app)
[[ $app_password =~ ^[a-f0-9]{64}$ ]]
printf 'postgres://mission_app:%s@%s:5432/mission_proof\n' "$app_password" "$ip" > "$ROOT/staging/database-url"
unset app_password; chmod 0400 "$ROOT/staging/database-url"
dc inspect --format '{{json .}}' "$dbid" | jq '{Id,Image,State,Config:{Image:.Config.Image,Labels:.Config.Labels},HostConfig:{Runtime:.HostConfig.Runtime,Memory:.HostConfig.Memory,NanoCpus:.HostConfig.NanoCpus,PidsLimit:.HostConfig.PidsLimit,PortBindings:.HostConfig.PortBindings,Binds:.HostConfig.Binds},NetworkSettings:{Networks:.NetworkSettings.Networks}}' > "$ROOT/database-inspect.json"
chmod 0400 "$ROOT/database-inspect.json"
[[ $(dc inspect --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.Runtime}} {{.State.Status}}' codex-universal) == "$PROTECTED" ]]
echo "postgres_setup=READY database=$dbid network=$netid image=sha256:b0f956... ports=none bind_mounts=none credential_file=root-only"
