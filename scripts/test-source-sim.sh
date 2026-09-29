#!/bin/sh
# Assert that the synthetic source still has the shape the ingestion work
# relies on. These are not database tests for their own sake: each case here
# is a situation the metadata-driven pipeline has to handle correctly, and a
# pipeline test is only meaningful if the source still presents the case.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

# Git Bash on Windows rewrites container-absolute paths in `docker compose
# exec` arguments unless this is set. Harmless everywhere else.
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

failures=0

# Runs one SQL expression as the least-privilege reader and compares the
# single value it returns.
expect_value() {
  case_name="$1"
  expected="$2"
  statement="$3"

  actual="$(printf '%s\n' "${statement}" | docker compose exec -T source-sim /bin/sh -ec \
    'PGPASSWORD="${SOURCE_SIM_READER_PASSWORD}" psql --username ingest_reader \
       --dbname "${POSTGRES_DB}" --host 127.0.0.1 \
       --no-align --tuples-only --set ON_ERROR_STOP=1 -f -' 2>/dev/null || true)"

  if [ "${actual}" = "${expected}" ]; then
    echo "PASS ${case_name}"
  else
    failures=$((failures + 1))
    echo "FAIL ${case_name}: expected '${expected}', got '${actual}'" >&2
  fi
}

expect_value "the classification registry is populated" "51" \
  "SELECT count(*) FROM meta.db_column;"

expect_value "personal columns are marked sensitive" "18" \
  "SELECT count(*) FROM meta.db_column WHERE classification = 'sensitive';"

expect_value "a mixed table keeps some safe columns" "6" \
  "SELECT count(*) FROM meta.db_column
    WHERE schema_name = 'hr' AND table_name = 'employee' AND classification = 'public';"

expect_value "one registered table has no safe column at all" "1" \
  "SELECT count(*) FROM (
     SELECT t.schema_name, t.table_name
     FROM meta.db_table t
     JOIN meta.db_column c ON c.schema_name = t.schema_name AND c.table_name = t.table_name
     GROUP BY 1, 2
     HAVING count(*) FILTER (WHERE c.classification = 'public') = 0
   ) AS zero_safe;"

expect_value "one registered table is withdrawn by its owner" "1" \
  "SELECT count(*) FROM meta.db_table WHERE NOT is_active;"

expect_value "one table exists with no registry entry" "1" \
  "SELECT count(*) FROM information_schema.tables it
    WHERE it.table_schema IN ('hr', 'academic')
      AND NOT EXISTS (SELECT 1 FROM meta.db_table t
                      WHERE t.schema_name = it.table_schema
                        AND t.table_name = it.table_name);"

expect_value "there is enough data to exercise batching" "60000" \
  "SELECT count(*) FROM academic.enrollment;"

# Defence in depth: even if the pipeline's column filter regressed, the
# health table is not readable by the identity the pipeline connects as.
health_read="$(printf 'SELECT count(*) FROM hr.employee_health;\n' \
  | docker compose exec -T source-sim /bin/sh -ec \
    'PGPASSWORD="${SOURCE_SIM_READER_PASSWORD}" psql --username ingest_reader \
       --dbname "${POSTGRES_DB}" --host 127.0.0.1 --tuples-only --no-align -f -' 2>&1 || true)"
case "${health_read}" in
  *"permission denied"*)
    echo "PASS the reader identity cannot read the all-sensitive table"
    ;;
  *)
    failures=$((failures + 1))
    echo "FAIL the reader identity could read hr.employee_health" >&2
    ;;
esac

if [ "${failures}" -ne 0 ]; then
  echo "${failures} synthetic source test(s) failed" >&2
  exit 1
fi
echo "All synthetic source tests passed"
