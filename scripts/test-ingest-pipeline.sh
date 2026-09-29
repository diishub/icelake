#!/bin/sh
# Prove what the ingestion pipeline actually produced.
#
# The cases that matter are the negative ones: a column the source classified
# as personal data must not exist in the lakehouse at all, and a table with no
# safe column must not exist either. Counting rows is the easy part.
#
# Run after ./scripts/run-ingest-once.sh.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

admin_user="$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)"
admin_password="$(trino_password_for PSU_ADMIN_PASSWORD)"
failures=0

trino_query() {
  trino_sql "${admin_user}" "${admin_password}" "$1" --output-format TSV | tr -d '"'
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

# The whole point of the pipeline: these column names exist in the source and
# must not have reached the lakehouse.
expect_equals "no personal column from hr.employee reached the lakehouse" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.columns
      WHERE table_schema = 'raw' AND table_name = 'sim_hr_employee'
        AND column_name IN ('citizen_id','full_name_thai','full_name_eng','birth_date','phone','email','home_address','monthly_salary')")"

expect_equals "no personal column from academic.student reached the lakehouse" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.columns
      WHERE table_schema = 'raw' AND table_name = 'sim_academic_student'
        AND column_name IN ('citizen_id','full_name_thai','birth_date','phone','email')")"

expect_equals "the sensitive grade column was left behind" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.columns
      WHERE table_schema = 'raw' AND table_name = 'sim_academic_enrollment' AND column_name = 'grade'")"

expect_equals "the all-sensitive table was never created" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.tables
      WHERE table_schema = 'raw' AND table_name = 'sim_hr_employee_health'")"

expect_equals "the withdrawn table was never created" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.tables
      WHERE table_schema = 'raw' AND table_name = 'sim_hr_retired_lookup'")"

expect_equals "the unregistered table was never created" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.tables
      WHERE table_schema = 'raw' AND table_name = 'sim_hr_unregistered_scratch'")"

# The safe columns did arrive, so the filter is not simply dropping everything.
expect_equals "the safe columns of hr.employee did arrive" "6" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.columns
      WHERE table_schema = 'raw' AND table_name = 'sim_hr_employee'
        AND column_name IN ('employee_id','department_id','position_id','employment_type','start_date','is_active')")"

# Every ingested table carries the audit columns, so a row can always be
# traced back to the run that produced it.
expect_equals "every ingested table carries the four audit columns" "0" \
  "$(trino_query "SELECT count(*) FROM (
        SELECT table_name FROM polaris.information_schema.columns
        WHERE table_schema = 'raw'
          AND column_name IN ('_ingested_at','_source_system','_source_table','_run_id')
        GROUP BY table_name HAVING count(*) <> 4)")"


expect_equals "row counts match the source" "5000 20000 60000 12 20 200"   "$(trino_query "SELECT concat_ws(' ',
        CAST((SELECT count(*) FROM polaris.raw.sim_hr_employee) AS varchar),
        CAST((SELECT count(*) FROM polaris.raw.sim_academic_student) AS varchar),
        CAST((SELECT count(*) FROM polaris.raw.sim_academic_enrollment) AS varchar),
        CAST((SELECT count(*) FROM polaris.raw.sim_hr_department) AS varchar),
        CAST((SELECT count(*) FROM polaris.raw.sim_hr_position) AS varchar),
        CAST((SELECT count(*) FROM polaris.raw.sim_academic_course) AS varchar))")"

# A skip has to be visible and explained, not silent.
skip_note="$(docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --no-align --tuples-only --quiet --no-psqlrc -f -' <<'SQL'
SELECT count(*) FROM ingest.ingest_run
WHERE target_table = 'raw.sim_hr_employee_health'
  AND status = 'skipped' AND skip_reason LIKE '%not safe%';
SQL
)"
if [ "${skip_note}" -ge 1 ] 2>/dev/null; then
  echo "PASS the skipped table is recorded with a reason"
else
  failures=$((failures + 1))
  echo "FAIL the skipped table is recorded with a reason: got '${skip_note}'" >&2
fi

if [ "${failures}" -ne 0 ]; then
  echo "${failures} ingestion pipeline test(s) failed" >&2
  exit 1
fi
echo "All ingestion pipeline tests passed"
