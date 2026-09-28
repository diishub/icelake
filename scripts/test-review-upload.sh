#!/bin/sh
# End-to-end check of the analyst review path:
# 1. Steward uploads multi-column CSV
# 2. Analyst lists reviews, previews schema/sample
# 3. Analyst approves with column classifications (public vs sensitive)
# 4. Trino creates polaris.raw."steward_eng_<suffix>" and inserts public columns
# 5. Database status updates to 'registered'
unset MSYS_NO_PATHCONV || true
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

portal_base="http://127.0.0.1:8085"
steward_email="synthetic-steward@example.invalid"
analyst_email="synthetic-analyst@example.invalid"
test_org_unit="eng"
failures=0

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }

run_sql_as_owner() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc -c \"$1\""
}

run_sql_as_owner_tuples() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc --tuples-only --no-align -c \"$1\""
}

work_dir="$(mktemp -d)"
csv_file="${work_dir}/student_scores.csv"
steward_jar="${work_dir}/steward_cookies.txt"
analyst_jar="${work_dir}/analyst_cookies.txt"

cleanup() {
  rm -rf "${work_dir}"
  run_sql_as_owner "DELETE FROM identity.upload_event WHERE user_id IN (SELECT user_id FROM identity.app_user WHERE email IN ('${steward_email}', '${analyst_email}'))" >/dev/null 2>&1 || true
  run_sql_as_owner "DELETE FROM identity.app_user WHERE email IN ('${steward_email}', '${analyst_email}')" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! curl -sf "${portal_base}/auth/health" >/dev/null; then
  echo "SKIP psu-auth is not running"
  exit 0
fi

cleanup >/dev/null 2>&1 || true
mkdir -p "${work_dir}"

# 1. Create test CSV with public and sensitive columns
cat << 'CSV' > "${csv_file}"
course_id,course_name,credits,student_id,student_name,score
241-101,Intro to Computing,3,6510110001,Somchai Jaidee,85
241-102,Data Structures,4,6510110002,Somsak Rakdee,92
CSV

# 2. Provision Steward Account
steward_out="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${steward_email}" "Synthetic Steward" 2>&1)"
steward_pass="$(printf '%s\n' "${steward_out}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'steward', org_unit = '${test_org_unit}' WHERE email = '${steward_email}'" >/dev/null

# 3. Steward login and upload
curl -s -o /dev/null -c "${steward_jar}" -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${steward_email}\",\"password\":\"${steward_pass}\"}"

upload_res="$(curl -s -w '\n%{http_code}' -b "${steward_jar}" -F "file=@${csv_file}" "${portal_base}/auth/uploads")"
upload_status="$(printf '%s' "${upload_res}" | tail -1)"
upload_body="$(printf '%s' "${upload_res}" | sed '$d')"

[ "${upload_status}" = "200" ] && pass "steward upload succeeded" \
  || fail "steward upload succeeded" "expected 200, got ${upload_status}: ${upload_body}"

upload_id="$(printf '%s' "${upload_body}" | sed -n 's/.*"uploadId":"\([^"]*\)".*/\1/p')"

# 4. Provision Analyst Account
analyst_out="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${analyst_email}" "Synthetic Analyst" 2>&1)"
analyst_pass="$(printf '%s\n' "${analyst_out}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'analyst' WHERE email = '${analyst_email}'" >/dev/null

# 5. Analyst login
curl -s -o /dev/null -c "${analyst_jar}" -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${analyst_email}\",\"password\":\"${analyst_pass}\"}"

# 6. Analyst lists reviews
reviews_res="$(curl -s -b "${analyst_jar}" "${portal_base}/auth/reviews")"
case "${reviews_res}" in
  *"${upload_id}"*)
    pass "analyst can list pending review containing upload_id"
    ;;
  *)
    fail "analyst can list pending review" "upload_id not found in response: ${reviews_res}"
    ;;
esac

# 7. Analyst gets review preview
preview_res="$(curl -s -b "${analyst_jar}" "${portal_base}/auth/reviews/${upload_id}/preview")"
case "${preview_res}" in
  *"course_id"*"Intro to Computing"*)
    pass "analyst preview extracts columns and sample data"
    ;;
  *)
    fail "analyst preview extracts columns" "missing expected columns in preview: ${preview_res}"
    ;;
esac

# 8. Analyst approves upload and creates Iceberg table (classifying columns)
unique_suffix="t$(date +%s)"
approve_payload="$(cat << JSON
{
  "tableSuffix": "scores_${unique_suffix}",
  "columns": [
    {"name": "course_id", "type": "VARCHAR", "classification": "public"},
    {"name": "course_name", "type": "VARCHAR", "classification": "public"},
    {"name": "credits", "type": "INTEGER", "classification": "public"},
    {"name": "student_id", "type": "VARCHAR", "classification": "sensitive"},
    {"name": "student_name", "type": "VARCHAR", "classification": "sensitive"},
    {"name": "score", "type": "INTEGER", "classification": "sensitive"}
  ]
}
JSON
)"

approve_res="$(curl -s -w '\n%{http_code}' -b "${analyst_jar}" -X POST "${portal_base}/auth/reviews/${upload_id}/approve" \
  -H 'Content-Type: application/json' \
  -d "${approve_payload}")"
approve_status="$(printf '%s' "${approve_res}" | tail -1)"
approve_body="$(printf '%s' "${approve_res}" | sed '$d')"

[ "${approve_status}" = "200" ] && pass "analyst approval succeeded" \
  || fail "analyst approval succeeded" "expected 200, got ${approve_status}: ${approve_body}"

# 9. Verify database record
db_status="$(run_sql_as_owner_tuples "SELECT status FROM identity.upload_event WHERE upload_id = '${upload_id}'" | tr -d '[:space:]')"
[ "${db_status}" = "registered" ] && pass "database record status is registered" \
  || fail "database record status" "expected registered, got '${db_status}'"

db_table="$(run_sql_as_owner_tuples "SELECT target_table FROM identity.upload_event WHERE upload_id = '${upload_id}'" | tr -d '[:space:]')"
expected_table="steward_eng_scores_${unique_suffix}"
[ "${db_table}" = "${expected_table}" ] && pass "target_table recorded accurately" \
  || fail "target_table" "expected ${expected_table}, got '${db_table}'"

cols_inc="$(run_sql_as_owner_tuples "SELECT columns_included FROM identity.upload_event WHERE upload_id = '${upload_id}'" | tr -d '[:space:]')"
cols_exc="$(run_sql_as_owner_tuples "SELECT columns_excluded FROM identity.upload_event WHERE upload_id = '${upload_id}'" | tr -d '[:space:]')"
[ "${cols_inc}" = "3" ] && pass "columns_included is 3" || fail "columns_included" "got ${cols_inc}"
[ "${cols_exc}" = "3" ] && pass "columns_excluded is 3" || fail "columns_excluded" "got ${cols_exc}"

# Clean up Trino test table
MSYS_NO_PATHCONV=1 docker compose exec -T trino trino --insecure --server https://localhost:8443 --user nifi \
  --execute "DROP TABLE IF EXISTS polaris.raw.\"${expected_table}\"" >/dev/null 2>&1 || true

if [ "${failures}" -eq 0 ]; then
  echo "ALL ANALYST REVIEW TESTS PASSED!"
else
  echo "${failures} test(s) failed" >&2
  exit 1
fi
