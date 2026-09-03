#!/bin/sh
# Create the least-privilege login the ingestion pipeline uses against this
# synthetic source. The pipeline never connects as the database owner.
#
# Runs after the schema and data scripts because the Postgres entrypoint
# executes /docker-entrypoint-initdb.d in filename order.
set -eu

: "${SOURCE_SIM_READER_PASSWORD:?SOURCE_SIM_READER_PASSWORD must be set for the synthetic source}"

# The password is passed as a psql variable and interpolated with :'name', so
# psql does the quoting and the value never has to be escaped by hand here.
psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  --set ON_ERROR_STOP=1 \
  --set reader_password="${SOURCE_SIM_READER_PASSWORD}" <<'SQL'
CREATE ROLE ingest_reader LOGIN PASSWORD :'reader_password';

REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO ingest_reader;

GRANT USAGE ON SCHEMA meta, hr, academic TO ingest_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA meta, hr, academic TO ingest_reader;

-- Health data has no safe column at all, so the pipeline has no legitimate
-- reason to read it. Revoking here is defence in depth, not a substitute for
-- the pipeline's own column filter: if the filter ever regresses, this turns
-- a silent leak into a permission error.
REVOKE SELECT ON hr.employee_health FROM ingest_reader;

-- A table added later is not readable by ingest_reader unless it is granted
-- explicitly: PostgreSQL grants new tables to their owner only.
SQL

echo "source-sim: ingest_reader role created with read-only access"
