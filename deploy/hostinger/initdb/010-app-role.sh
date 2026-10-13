#!/bin/sh
set -eu
APP_PASSWORD=$(cat /run/secrets/app_password)
export APP_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_PASSWORD
CREATE ROLE orloom_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE orloom TO orloom_app;
GRANT USAGE, CREATE ON SCHEMA public TO orloom_app;
SQL
unset APP_PASSWORD
