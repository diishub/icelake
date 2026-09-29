#!/bin/sh
# Prove the maintenance identity can do its job and nothing else.
#
# Maintenance rewrites and deletes files, so it is the identity with the most
# destructive reach in the stack. The cases that matter are the ones showing
# it still cannot see a single value in the data it maintains.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

maintenance_user="$(grep '^TRINO_MAINTENANCE_USERNAME=' .env | cut -d= -f2- || true)"
maintenance_user="${maintenance_user:-maintenance}"
maintenance_password="$(trino_password_for TRINO_MAINTENANCE_PASSWORD)"
failures=0

as_maintenance() {
  trino_sql "${maintenance_user}" "${maintenance_password}" "$1" || true
}

expect_denied() {
  case_name="$1"; output="$2"
  case "${output}" in
    *"Access Denied"*) echo "PASS ${case_name}" ;;
    *) failures=$((failures + 1)); echo "FAIL ${case_name}: the statement was allowed" >&2 ;;
  esac
}

expect_allowed() {
  case_name="$1"; output="$2"
  case "${output}" in
    *"Access Denied"*) failures=$((failures + 1)); echo "FAIL ${case_name}: ${output}" >&2 ;;
    *) echo "PASS ${case_name}" ;;
  esac
}

expect_denied "maintenance cannot read a column of the data it maintains" \
  "$(as_maintenance 'SELECT employee_id FROM polaris.raw.sim_hr_employee LIMIT 1')"

expect_denied "maintenance cannot read the staging catalog either" \
  "$(as_maintenance 'SELECT * FROM hive.information_schema.tables LIMIT 1')"

expect_denied "maintenance cannot set an unrelated session property" \
  "$(as_maintenance 'SET SESSION polaris.projection_pushdown_enabled = false')"

expect_allowed "maintenance can compact a table" \
  "$(as_maintenance 'ALTER TABLE polaris.raw.sim_hr_department EXECUTE optimize')"

expect_allowed "maintenance can list what exists" \
  "$(as_maintenance 'SHOW TABLES FROM polaris.raw')"

# Maintenance that leaves no trail is not auditable, and file deletion is
# exactly the kind of action an audit asks about later.
recorded="$(docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --no-align --tuples-only --quiet --no-psqlrc -f -' <<'SQL'
SELECT count(*) FROM ingest.maintenance_run
WHERE status = 'succeeded' AND action = 'remove_orphan_files';
SQL
)"
if [ "${recorded}" -ge 1 ] 2>/dev/null; then
  echo "PASS orphan-file removal is recorded in the maintenance log"
else
  failures=$((failures + 1))
  echo "FAIL orphan-file removal is recorded in the maintenance log: got '${recorded}'" >&2
fi

# A table that was never loaded has no Iceberg table behind it, and reporting
# that as a maintenance failure would teach people to ignore failures.
never_loaded="$(docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --no-align --tuples-only --quiet --no-psqlrc -f -' <<'SQL'
SELECT count(*) FROM ingest.v_maintenance_targets
WHERE target_table = 'raw.sim_hr_employee_health';
SQL
)"
if [ "${never_loaded}" = "0" ]; then
  echo "PASS the skipped table is not offered up for maintenance"
else
  failures=$((failures + 1))
  echo "FAIL the skipped table is not offered up for maintenance: got '${never_loaded}'" >&2
fi

if [ "${failures}" -ne 0 ]; then
  echo "${failures} maintenance test(s) failed" >&2
  exit 1
fi
echo "All maintenance tests passed"
