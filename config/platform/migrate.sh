#!/bin/sh
# Create and migrate the ingestion control-plane database.
#
# Runs as a one-shot Compose service rather than as a PostgreSQL init script,
# because the PostgreSQL instance in this stack was initialised long ago and
# never runs its init scripts again. Everything here is idempotent, so it is
# safe on both a fresh machine and an existing one.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${PGPASSWORD:?POSTGRES_PASSWORD must be passed in as PGPASSWORD}"
: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD must be set for the platform_app role}"
: "${PLATFORM_READ_PASSWORD:?PLATFORM_READ_PASSWORD must be set for the platform_trino role}"

platform_db="platform"
psql_admin="psql --host postgres --username ${POSTGRES_USER} --set ON_ERROR_STOP=1 --no-psqlrc"

# CREATE DATABASE has no IF NOT EXISTS and cannot run inside a transaction,
# so it is guarded by a lookup instead.
if ${psql_admin} --dbname postgres --tuples-only --no-align \
     --command "SELECT 1 FROM pg_database WHERE datname = '${platform_db}'" | grep -qx 1; then
  echo "database ${platform_db} already exists"
else
  ${psql_admin} --dbname postgres --command "CREATE DATABASE ${platform_db}"
  echo "database ${platform_db} created"
fi

for migration in /migrations/[0-9]*.sql; do
  echo "applying $(basename "${migration}")"
  # Values a seed migration may need. Unused variables are harmless to
  # the migrations that do not reference them.
  ${psql_admin} --dbname "${platform_db}" \
    --set source_sim_host="source-sim" \
    --set source_sim_port="5432" \
    --set source_sim_db="${SOURCE_SIM_DB:-lakehouse_sim}" \
    --file "${migration}" >/dev/null
done

# Set the password last and separately, so it never sits in a file on disk and
# is never echoed by the migration output above. psql does not substitute its
# own variables inside --command, so the statement arrives on standard input,
# where :'name' interpolation applies and psql does the quoting.
${psql_admin} --dbname "${platform_db}" --quiet \
  --set app_password="${PLATFORM_DB_PASSWORD}" \
  --set read_password="${PLATFORM_READ_PASSWORD}" --file - >/dev/null <<'STATEMENT'
ALTER ROLE platform_app PASSWORD :'app_password';
ALTER ROLE platform_trino PASSWORD :'read_password';
STATEMENT
echo "platform_app and platform_trino passwords applied"

echo "platform control-plane migration complete"
