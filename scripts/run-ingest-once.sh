#!/bin/sh
# Run the metadata-driven ingestion flow once and report what it did.
#
# Starts the process group, stops the trigger as soon as it has fired so the
# run does not repeat, waits for the control plane to show no run still in
# progress, then stops the group again and prints the run log.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

docker compose exec -T nifi /bin/sh -s < scripts/nifi/run-ingest-once.container.sh

echo
echo "=== ingest runs from the last 10 minutes ==="
docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform --no-psqlrc -f -' \
  < scripts/sql/ingest-run-report.sql
