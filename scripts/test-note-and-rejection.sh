#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

portal_base="http://127.0.0.1:8085"
steward_email="test-note-steward@example.invalid"
analyst_email="test-note-analyst@example.invalid"
test_org_unit="eng"

run_sql_as_owner() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc -c \"$1\""
}

run_sql_as_owner_tuples() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc --tuples-only --no-align -c \"$1\""
}

work_dir="$(mktemp -d)"
csv_file="${work_dir}/test.csv"
steward_jar="${work_dir}/steward.txt"
analyst_jar="${work_dir}/analyst.txt"

cleanup() {
  rm -rf "${work_dir}"
  run_sql_as_owner "DELETE FROM identity.upload_event WHERE user_id IN (SELECT user_id FROM identity.app_user WHERE email IN ('${steward_email}', '${analyst_email}'))" >/dev/null 2>&1 || true
  run_sql_as_owner "DELETE FROM identity.app_user WHERE email IN ('${steward_email}', '${analyst_email}')" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup >/dev/null 2>&1 || true
mkdir -p "${work_dir}"

printf 'col1,col2\nval1,val2\n' > "${csv_file}"

# 1. Provision Steward
steward_out="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${steward_email}" "Steward Note Tester" 2>&1)"
steward_pass="$(printf '%s\n' "${steward_out}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'steward', org_unit = '${test_org_unit}' WHERE email = '${steward_email}'" >/dev/null

curl -s -o /dev/null -c "${steward_jar}" -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${steward_email}\",\"password\":\"${steward_pass}\"}"

# 2. Upload with Note
test_note="hello world note"
upload_res="$(curl -s -b "${steward_jar}" -F "file=@${csv_file}" -F "note=${test_note}" "${portal_base}/auth/uploads")"
upload_id="$(printf '%s' "${upload_res}" | sed -n 's/.*"uploadId":"\([^"]*\)".*/\1/p')"

echo "Upload ID: ${upload_id}"

# Verify uploader_note in DB
note_in_db="$(run_sql_as_owner_tuples "SELECT uploader_note FROM identity.upload_event WHERE upload_id = '${upload_id}'")"
echo "note_in_db: '${note_in_db}'"
[ "${note_in_db}" = "${test_note}" ] && echo "PASS: uploader_note successfully saved to DB"

# 3. Provision Analyst
analyst_out="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${analyst_email}" "Analyst Note Tester" 2>&1)"
analyst_pass="$(printf '%s\n' "${analyst_out}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'analyst' WHERE email = '${analyst_email}'" >/dev/null

curl -s -o /dev/null -c "${analyst_jar}" -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${analyst_email}\",\"password\":\"${analyst_pass}\"}"

# 4. Analyst previews upload
preview_res="$(curl -s -b "${analyst_jar}" "${portal_base}/auth/reviews/${upload_id}/preview")"
case "${preview_res}" in
  *"${test_note}"*)
    echo "PASS: analyst preview contains steward note"
    ;;
  *)
    echo "FAIL: steward note missing from preview" >&2
    exit 1
    ;;
esac

# 5. Analyst rejects with reason
test_reason="Missing required columns"
reject_res="$(curl -s -b "${analyst_jar}" -X POST "${portal_base}/auth/reviews/${upload_id}/reject" \
  -H 'Content-Type: application/json' \
  -d "{\"reason\":\"${test_reason}\"}")"

echo "Reject response: ${reject_res}"

# Verify rejection_reason in DB
reason_in_db="$(run_sql_as_owner_tuples "SELECT rejection_reason FROM identity.upload_event WHERE upload_id = '${upload_id}'")"
[ "${reason_in_db}" = "${test_reason}" ] && echo "PASS: rejection_reason successfully saved to DB"

# 6. Steward checks history
steward_history="$(curl -s -b "${steward_jar}" "${portal_base}/auth/uploads")"
case "${steward_history}" in
  *"${test_reason}"*"${test_note}"*|*"${test_note}"*"${test_reason}"*)
    echo "PASS: steward history shows both note and rejection reason"
    ;;
  *)
    echo "FAIL: steward history missing note or reason: ${steward_history}" >&2
    exit 1
    ;;
esac

echo "ALL NOTE AND REJECTION TESTS PASSED!"
