#!/bin/sh
# End-to-end check of the viewer upload path (portal/src/pages/upload.tsx ->
# POST /auth/uploads -> RustFS staging + identity.upload_event), the same
# way test-password-login.sh exercises sign-in over real HTTP rather than
# only at the schema level.
unset MSYS_NO_PATHCONV || true
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

portal_base="http://127.0.0.1:8085"
test_email="synthetic-upload-test@example.invalid"
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

# Plain "-F file=@path" uses the path's own basename as the filename this
# server sees; the Windows curl.exe in this environment mis-parses the
# "@path;filename=..." modifier form (a bare 000/exit-26 read error), so two
# distinctly-named files stand in for it instead of one file reused under two
# names.
work_dir="$(mktemp -d)"
csv_file="${work_dir}/synthetic.csv"
txt_file="${work_dir}/not-a-csv.txt"
jar="${work_dir}/cookies.txt"
cleanup() {
  rm -rf "${work_dir}"
  run_sql_as_owner "DELETE FROM identity.app_user WHERE email = '${test_email}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! curl -sf "${portal_base}/auth/health" >/dev/null; then
  echo "SKIP psu-auth is not running (docker compose --profile auth up -d psu-auth)"
  exit 0
fi

cleanup >/dev/null 2>&1 || true
mkdir -p "${work_dir}"
printf 'name,value\nsynthetic,1\n' > "${csv_file}"
printf 'name,value\nsynthetic,1\n' > "${txt_file}"

status="$(curl -s -o /dev/null -w '%{http_code}' -F "file=@${csv_file}" "${portal_base}/auth/uploads")"
[ "${status}" = "401" ] && pass "no session is refused" \
  || fail "no session is refused" "expected 401, got ${status}"

echo "provisioning a synthetic analyst account (wrong tier for uploads)..." >&2
create_output="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${test_email}" "Synthetic Upload Test" 2>&1)"
password="$(printf '%s\n' "${create_output}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"
if [ -z "${password}" ]; then
  echo "could not extract the generated password from create-password-account.sh output:" >&2
  echo "${create_output}" >&2
  exit 1
fi
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'analyst' WHERE email = '${test_email}'" >/dev/null

curl -s -o /dev/null -c "${jar}" -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${test_email}\",\"password\":\"${password}\"}"

status="$(curl -s -o /dev/null -w '%{http_code}' -b "${jar}" -F "orgUnit=${test_org_unit}" -F "file=@${csv_file}" "${portal_base}/auth/uploads")"
[ "${status}" = "403" ] && pass "a tier with no upload permission (analyst) is refused" \
  || fail "a tier with no upload permission (analyst) is refused" "expected 403, got ${status}"

# A viewer submits files and names the org unit per upload (config/platform/024-three-tiers.sql).
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'viewer' WHERE email = '${test_email}'" >/dev/null

status="$(curl -s -o /dev/null -w '%{http_code}' -b "${jar}" -F "file=@${csv_file}" "${portal_base}/auth/uploads")"
[ "${status}" = "400" ] && pass "an upload with no org unit is rejected" \
  || fail "an upload with no org unit is rejected" "expected 400, got ${status}"

status="$(curl -s -o /dev/null -w '%{http_code}' -b "${jar}" -F "orgUnit=../eng" -F "file=@${csv_file}" "${portal_base}/auth/uploads")"
[ "${status}" = "400" ] && pass "an org unit outside a-z 0-9 _ - is rejected" \
  || fail "an org unit outside a-z 0-9 _ - is rejected" "expected 400, got ${status}"

status="$(curl -s -o /dev/null -w '%{http_code}' -b "${jar}" -F "orgUnit=${test_org_unit}" -F "file=@${txt_file}" "${portal_base}/auth/uploads")"
[ "${status}" = "400" ] && pass "a non-csv file is rejected" \
  || fail "a non-csv file is rejected" "expected 400, got ${status}"

response="$(curl -s -w '\n%{http_code}' -b "${jar}" -F "orgUnit=${test_org_unit}" -F "file=@${csv_file}" "${portal_base}/auth/uploads")"
status="$(printf '%s' "${response}" | tail -1)"
body="$(printf '%s' "${response}" | sed '$d')"

if [ "${status}" = "200" ]; then
  pass "a viewer account can upload a csv"
else
  fail "a viewer account can upload a csv" "expected 200, got ${status}: ${body}"
fi

object_key="$(printf '%s' "${body}" | sed -n 's/.*"objectKey":"\([^"]*\)".*/\1/p')"
case "${object_key}" in
  "staging/uploads/${test_org_unit}/"*)
    pass "the staged object key is scoped to the org unit named in the upload"
    ;;
  *)
    fail "the staged object key is scoped to the org unit named in the upload" "got '${object_key}'"
    ;;
esac

row_count="$(run_sql_as_owner_tuples \
  "SELECT count(*) FROM identity.upload_event WHERE object_key = '${object_key}' AND status = 'pending_review'" \
  | tr -d '[:space:]')"
[ "${row_count}" = "1" ] && pass "the upload is recorded as pending_review" \
  || fail "the upload is recorded as pending_review" "expected 1 matching row, got '${row_count}'"

if [ "${failures}" -eq 0 ]; then
  echo "all data upload cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
