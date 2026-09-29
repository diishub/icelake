#!/bin/sh
# Assert the ingestion control plane enforces what it claims to enforce.
#
# The point of these cases is not that the tables exist -- it is that the
# pipeline identity cannot quietly widen its own scope, and that a run record
# that would be misleading is rejected by the database rather than by whoever
# happens to read the dashboard.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

platform_password="$(grep '^PLATFORM_DB_PASSWORD=' .env | cut -d= -f2-)"
failures=0

# Runs SQL as the least-privilege pipeline identity.
as_app() {
  docker compose exec -T -e PGPASSWORD="${platform_password}" postgres \
    psql --host 127.0.0.1 --username platform_app --dbname platform \
      --no-align --tuples-only --quiet --no-psqlrc -f - 2>&1
}

# Runs SQL as the database owner, for cases about constraints rather than
# privileges.
as_owner() {
  docker compose exec -T postgres /bin/sh -ec \
    'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" \
       --dbname platform --no-align --tuples-only --quiet --no-psqlrc -f -' 2>&1
}

expect_equals() {
  case_name="$1"; expected="$2"; actual="$3"
  if [ "${actual}" = "${expected}" ]; then
    echo "PASS ${case_name}"
  else
    failures=$((failures + 1))
    echo "FAIL ${case_name}: expected '${expected}', got '${actual}'" >&2
  fi
}

expect_refused() {
  case_name="$1"; output="$2"
  case "${output}" in
    *"permission denied"*|*"ERROR"*)
      echo "PASS ${case_name}"
      ;;
    *)
      failures=$((failures + 1))
      echo "FAIL ${case_name}: the statement was accepted" >&2
      ;;
  esac
}

expect_equals "the synthetic source is registered" "source-sim" \
  "$(printf 'SELECT source_key FROM ingest.source_system;\n' | as_app)"

expect_equals "every case-covering table is registered" "8" \
  "$(printf 'SELECT count(*) FROM ingest.source_table;\n' | as_app)"

expect_equals "the withdrawn table stays disabled" "1" \
  "$(printf 'SELECT count(*) FROM ingest.source_table WHERE NOT is_enabled;\n' | as_app)"

expect_equals "one table is registered for incremental loading" "1" \
  "$(printf "SELECT count(*) FROM ingest.source_table WHERE load_mode = 'incremental';\n" | as_app)"

# The pipeline reads the registry. It must not be able to add a source, enable
# one, or point an existing one somewhere else.
expect_refused "the pipeline cannot register a new source" \
  "$(printf "INSERT INTO ingest.source_system (source_key, display_name, source_kind, host, port, database_name, credentials_env_prefix, data_owner, lawful_basis, retention_note) VALUES ('x','x','postgresql','x',5432,'x','X','x','x','x');\n" | as_app)"

expect_refused "the pipeline cannot enable a table for itself" \
  "$(printf 'UPDATE ingest.source_table SET is_enabled = true;\n' | as_app)"

expect_refused "the pipeline cannot delete its own audit trail" \
  "$(printf 'DELETE FROM ingest.ingest_run;\n' | as_app)"

# What it must be able to do: record a run.
expect_equals "the pipeline can record a run" "1" \
  "$(printf "BEGIN; INSERT INTO ingest.ingest_run (source_key, target_table) VALUES ('source-sim','raw.probe'); SELECT count(*) FROM ingest.ingest_run WHERE target_table = 'raw.probe'; ROLLBACK;\n" | as_app | tail -1)"

# A run record that would mislead a reader is rejected by the database.
expect_refused "a skipped run must say why it was skipped" \
  "$(printf "INSERT INTO ingest.ingest_run (source_key, target_table, status, ended_at) VALUES ('source-sim','raw.probe','skipped', now());\n" | as_app)"

expect_refused "a failed run must carry an error message" \
  "$(printf "INSERT INTO ingest.ingest_run (source_key, target_table, status, ended_at) VALUES ('source-sim','raw.probe','failed', now());\n" | as_app)"

expect_refused "an incremental table must name its incremental column" \
  "$(printf "INSERT INTO ingest.source_table (source_system_id, source_schema, source_table_name, target_table_name, load_mode) SELECT source_system_id, 'x', 'x', 'x', 'incremental' FROM ingest.source_system LIMIT 1;\n" | as_owner)"

expect_refused "a source cannot be registered without a lawful basis" \
  "$(printf "INSERT INTO ingest.source_system (source_key, display_name, source_kind, host, port, database_name, credentials_env_prefix, data_owner, lawful_basis, retention_note) VALUES ('y','y','postgresql','y',5432,'y','Y','someone','   ','none');\n" | as_owner)"

# The safe / not-safe rule is computed by the database, not by each caller.
expect_equals "an unknown classification label is not treated as safe" "f" \
  "$(printf "BEGIN;
     INSERT INTO ingest.column_classification (source_system_id, source_schema, source_table_name, column_name, data_type, classification, secret_level)
     SELECT source_system_id, 'probe', 'probe', 'probe', 'text', 'brand-new-label', 0 FROM ingest.source_system WHERE source_key = 'source-sim';
     SELECT is_safe FROM ingest.column_classification WHERE source_schema = 'probe';
     ROLLBACK;\n" | as_app | tail -1)"

if [ "${failures}" -ne 0 ]; then
  echo "${failures} platform registry test(s) failed" >&2
  exit 1
fi
echo "All platform registry tests passed"
