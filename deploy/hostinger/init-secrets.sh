#!/bin/sh
set -eu
umask 077
ORLOOM_HOST=${1:?usage: init-secrets.sh hostname}
printf '%s' "$ORLOOM_HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' || { echo 'Invalid hostname' >&2; exit 2; }
if [ -d secrets ] && [ "$(find secrets -mindepth 1 -maxdepth 1 | wc -l)" -ne 0 ]; then
  echo 'Secret directory is not empty; refusing to overwrite or rotate secrets' >&2
  exit 3
fi
mkdir -p secrets
chmod 0700 secrets
openssl rand -hex 32 > secrets/db_password
openssl rand -hex 32 > secrets/app_password
openssl rand -hex 32 > secrets/session_token
printf 'https://%s' "$ORLOOM_HOST" > secrets/public_origin
APP_PASSWORD=$(cat secrets/app_password)
printf 'postgres://orloom_app:%s@db:5432/orloom' "$APP_PASSWORD" > secrets/database_url
unset APP_PASSWORD
chmod 0400 secrets/db_password secrets/session_token
chown 70:70 secrets/app_password
chmod 0400 secrets/app_password
chmod 0400 secrets/public_origin secrets/database_url
chown 10001:10001 secrets/session_token secrets/public_origin secrets/database_url
