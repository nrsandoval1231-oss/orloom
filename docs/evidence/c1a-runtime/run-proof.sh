#!/usr/bin/env bash
set -euo pipefail
readonly LABEL=ORL-005C1A-PG-RUNTIME
readonly PREFIX=orloom-c1a-pg-proof-20261013
readonly DB=${PREFIX}-db TEST=${PREFIX}-test NET=${PREFIX}-net DATA=${PREFIX}-data SECRETS=${PREFIX}-secrets
readonly DB_ID=5bad5efd9fa38990585d319d17a40c0dafbd5569175831851a9265d055acabb7
readonly TEST_ID=4559a5efd42682f81b9365f036ebfc69411e19569dcc2a29c260a67e49e84698
readonly NET_ID=fdba65968353e6a78af722de4a7ac2499e9432f717b7e5f97f33e6e53893614a
readonly PG_IMAGE=sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
readonly TEST_IMAGE=sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
readonly PAYLOAD_SHA=77322aa943bc1df89931f96f917bfb020eb98385e3b590b543d50e22f3cc4ec3
readonly STAGING=/var/lib/orloom/c1a-pg-proof-20261013/staging
readonly RUN_RESULT=$STAGING/runtime-result-03.txt
[[ $# -eq 0 ]]
[[ $(docker inspect --format '{{.Id}}' "$DB") == "$DB_ID" ]]
[[ $(docker inspect --format '{{.Id}}' "$TEST") == "$TEST_ID" ]]
[[ $(docker inspect --format '{{.Image}}' "$DB") == "$PG_IMAGE" ]]
[[ $(docker inspect --format '{{.Image}}' "$TEST") == "$TEST_IMAGE" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$DB") == "$LABEL" ]]
[[ $(docker inspect --format '{{index .Config.Labels "orloom.packet"}}' "$TEST") == "$LABEL" ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$DB") == healthy ]]
[[ $(docker inspect --format '{{.HostConfig.Runtime}}' "$TEST") == runsc ]]
[[ $(docker network inspect --format '{{.Id}}' "$NET") == "$NET_ID" ]]
[[ $(docker network inspect --format '{{index .Labels "orloom.packet"}}' "$NET") == "$LABEL" ]]
[[ $(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET" | tr ' ' '\n' | sort | xargs) == "$DB $TEST" ]]
[[ $(docker inspect --format '{{(index .NetworkSettings.Networks "orloom-c1a-pg-proof-20261013-net").NetworkID}}' "$DB") == "$NET_ID" ]]
[[ $(docker inspect --format '{{(index .NetworkSettings.Networks "orloom-c1a-pg-proof-20261013-net").NetworkID}}' "$TEST") == "$NET_ID" ]]
DB_IP=$(docker inspect --format '{{(index .NetworkSettings.Networks "orloom-c1a-pg-proof-20261013-net").IPAddress}}' "$DB")
TEST_IP=$(docker inspect --format '{{(index .NetworkSettings.Networks "orloom-c1a-pg-proof-20261013-net").IPAddress}}' "$TEST")
SUBNET=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$NET")
python3 -c 'import ipaddress,sys; net=ipaddress.ip_network(sys.argv[1],strict=True); addrs=[ipaddress.ip_address(x) for x in sys.argv[2:]]; private=[ipaddress.ip_network(x) for x in ("10.0.0.0/8","172.16.0.0/12","192.168.0.0/16")]; assert any(net.subnet_of(x) for x in private); assert len(set(addrs))==2 and all(x in net for x in addrs)' "$SUBNET" "$DB_IP" "$TEST_IP"
[[ $(sha256sum "$STAGING/payload-manifest-04.sha256" | cut -d' ' -f1) == "$PAYLOAD_SHA" ]]
(cd "$STAGING/payload-04/app" && sha256sum --check "$STAGING/payload-manifest-04.sha256" >/dev/null)
[[ ! -e "$RUN_RESULT" ]]
printf '%s  %s\n' "$PAYLOAD_SHA" 'payload-manifest-04.sha256' > "$STAGING/identity-03.marker"
docker exec --user 65532:65532 "$TEST" /bin/sh -c 'mkdir -p /work/app-03'
docker exec --user 65532:65532 "$TEST" tar --version >/dev/null
(cd "$STAGING/payload-04/app" && tar -cf - .) | docker exec -i --user 65532:65532 "$TEST" /bin/sh -c 'tar -xf - -C /work/app-03'
cat "$STAGING/payload-manifest-04.sha256" | docker exec -i --user 65532:65532 "$TEST" /bin/sh -c 'cat > /work/app-03/payload-manifest-04.sha256'
[[ $(docker exec --user 65532:65532 "$TEST" /work/node --version) == v24.15.0 ]]
docker exec --user 65532:65532 --workdir=/work/app-03 "$TEST" sha256sum --check /work/app-03/payload-manifest-04.sha256 >/dev/null
[[ $(docker exec --user 65532:65532 "$TEST" /bin/sh -c 'stat -c "%u:%g:%a" /run/secrets/pg-password-test') == '65532:65532:400' ]]
set +e
docker exec --user 65532:65532 --workdir=/work/app-03 --env=ORLOOM_PG_HOST="$DB_IP" --env=ORLOOM_PG_PASSWORD_FILE=/run/secrets/pg-password-test --env=ORLOOM_PG_DATABASE=mission_proof_03 --env=ORLOOM_PG_AUX_DATABASE=mission_proof_aux_03 "$TEST" /work/node ./runtime-proof.mjs > "$RUN_RESULT" 2>&1
proof_exit=$?
set -e
cat "$RUN_RESULT"
printf 'runtime_exit=%s\n' "$proof_exit"
[[ $proof_exit -eq 0 ]]
