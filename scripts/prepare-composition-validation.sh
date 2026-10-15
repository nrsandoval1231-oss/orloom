#!/usr/bin/env bash
set -euo pipefail
validation_root=$(mktemp -d /tmp/orloom-composition-XXXXXX)
printf '%s\n' "$validation_root" > .orloom-validation-root
cd "$validation_root"
curl -fsSLO https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
grep ' node-v24.22.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
tar -xf node-v24.22.0-linux-x64.tar.xz
mkdir pgdata pgsocket
/usr/lib/postgresql/18/bin/initdb -D "$validation_root/pgdata" -A trust --no-locale > initdb.txt
/usr/lib/postgresql/18/bin/pg_ctl -D "$validation_root/pgdata" -l "$validation_root/postgres.txt" -o "-k $validation_root/pgsocket -h ''" start
"$validation_root/node-v24.22.0-linux-x64/bin/node" --version
printf 'Validation root: %s\n' "$validation_root"
