#!/bin/sh
# End-to-end check of the dataset release path (config/platform/021-dataset-release.sql):
#
#   1. an analyst requests that a curated table be published
#   2. a second open request for the same table is refused
#   3. nobody decides their own request, and a steward of another unit cannot
#      even see it
#   4. a rejection needs a reason
#   5. the owning unit's steward approves; psu-auth copies the pinned curated
#      snapshot into published as the publisher identity
#   6. the published copy matches, the release row is pinned to both snapshots,
#      and the public catalogue lists it without account or snapshot detail
#   7. analysts and ingestion still cannot write published directly
#
# Needs the stack with the auth profile running. Skips when psu-auth is down.
unset MSYS_NO_PATHCONV || true
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

. scripts/lib/trino.sh

portal_base="http://127.0.0.1:8085"
analyst_email="synthetic-release-analyst@example.invalid"
steward_email="synthetic-release-steward@example.invalid"
other_steward_email="synthetic-release-other@example.invalid"
table="release_test_t$(date +%s)"
failures=0

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }

run_sql_as_owner() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc --tuples-only --no-align -c \"$1\""
}

admin_user="$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)"
admin_password="$(trino_password_for PSU_ADMIN_PASSWORD)"
analyst_trino_user="$(grep '^PSU_ANALYST_USERNAME=' .env | cut -d= -f2)"
analyst_trino_password="$(trino_password_for PSU_ANALYST_PASSWORD)"
ingestion_user="$(grep '^TRINO_INGESTION_USERNAME=' .env | cut -d= -f2)"
ingestion_password="$(trino_password_for TRINO_INGESTION_PASSWORD)"

admin_sql() {
  MSYS_NO_PATHCONV=1 trino_sql "${admin_user}" "${admin_password}" "$1" --output-format TSV
}

work_dir="$(mktemp -d)"
analyst_jar="${work_dir}/analyst.txt"
steward_jar="${work_dir}/steward.txt"
other_jar="${work_dir}/other.txt"

cleanup() {
  rm -rf "${work_dir}"
  run_sql_as_owner "DELETE FROM identity.dataset_release WHERE table_name = '${table}'" >/dev/null 2>&1 || true
  run_sql_as_owner "DELETE FROM identity.app_user WHERE email IN ('${analyst_email}', '${steward_email}', '${other_steward_email}')" >/dev/null 2>&1 || true
  admin_sql "DROP TABLE IF EXISTS polaris.published.\"${table}\"" >/dev/null 2>&1 || true
  admin_sql "DROP TABLE IF EXISTS polaris.curated.\"${table}\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! curl -sf "${portal_base}/auth/health" >/dev/null; then
  echo "SKIP psu-auth is not running"
  exit 0
fi
cleanup >/dev/null 2>&1 || true
mkdir -p "${work_dir}"

# A small curated table with an org_unit column, as an analyst would leave it.
admin_sql "CREATE TABLE polaris.curated.\"${table}\" AS
  SELECT * FROM (VALUES ('eng', 10), ('eng', 20), ('med', 30)) AS t (org_unit, amount)" >/dev/null || {
  echo "FAIL could not create polaris.curated.${table} as ${admin_user}; is Trino healthy?" >&2
  exit 1
}

# Accounts: create-password-account.sh prints the generated password last.
make_account() {
  out="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "$1" "$2" 2>&1)"
  printf '%s\n' "${out}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1
}
login() {
  curl -s -o /dev/null -c "$1" -X POST "${portal_base}/auth/password/login" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$2\",\"password\":\"$3\"}"
}

analyst_pass="$(make_account "${analyst_email}" "Synthetic Release Analyst")"
steward_pass="$(make_account "${steward_email}" "Synthetic Release Steward")"
other_pass="$(make_account "${other_steward_email}" "Synthetic Other Steward")"
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'analyst' WHERE email = '${analyst_email}'" >/dev/null
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'steward', org_unit = 'eng' WHERE email = '${steward_email}'" >/dev/null
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'steward', org_unit = 'med' WHERE email = '${other_steward_email}'" >/dev/null
login "${analyst_jar}" "${analyst_email}" "${analyst_pass}"
login "${steward_jar}" "${steward_email}" "${steward_pass}"
login "${other_jar}" "${other_steward_email}" "${other_pass}"

# call <jar> <method> <path> [json]  ->  prints "<status> <body>"
call() {
  if [ -n "${4:-}" ]; then
    res="$(curl -s -w '\n%{http_code}' -b "$1" -X "$2" "${portal_base}$3" -H 'Content-Type: application/json' -d "$4")"
  else
    res="$(curl -s -w '\n%{http_code}' -b "$1" -X "$2" "${portal_base}$3")"
  fi
  printf '%s %s' "$(printf '%s' "${res}" | tail -1)" "$(printf '%s' "${res}" | sed '$d')"
}
expect_status() {
  got="${2%% *}"
  [ "${got}" = "$3" ] && pass "$1" || fail "$1" "expected $3, got ${2}"
}

# 1. The analyst sees the table and requests it.
sources="$(call "${analyst_jar}" GET /auth/releases/sources)"
case "${sources}" in
  "200 "*"\"${table}\""*) pass "analyst sees the curated table as a release source" ;;
  *) fail "analyst sees the curated table" "${sources}" ;;
esac

request_body="{\"tableName\":\"${table}\",\"titleTh\":\"ชุดทดสอบการเผยแพร่\",\"titleEn\":\"Release test\",\"ownerOrgUnit\":\"eng\",\"domain\":\"indicator\",\"tags\":[\"test\"],\"changelog\":\"first\"}"
created="$(call "${analyst_jar}" POST /auth/releases "${request_body}")"
expect_status "analyst request is recorded" "${created}" 201
release_id="$(printf '%s' "${created}" | sed -n 's/.*"releaseId":"\([^"]*\)".*/\1/p')"

# 2. One open request per table.
expect_status "a second open request for the same table is refused" \
  "$(call "${analyst_jar}" POST /auth/releases "${request_body}")" 409

# A steward cannot request; a table outside curated cannot be requested.
expect_status "a steward cannot request a release" \
  "$(call "${steward_jar}" POST /auth/releases "${request_body}")" 403
expect_status "a table not in curated is refused" \
  "$(call "${analyst_jar}" POST /auth/releases "{\"tableName\":\"no_such_table_here\",\"titleTh\":\"x\",\"ownerOrgUnit\":\"eng\"}")" 404

# 3. Nobody decides their own request; another unit's steward cannot see it.
expect_status "the requester cannot approve their own request" \
  "$(call "${analyst_jar}" POST "/auth/releases/${release_id}/approve")" 403
expect_status "another unit's steward cannot see the request" \
  "$(call "${other_jar}" POST "/auth/releases/${release_id}/approve")" 404
case "$(call "${other_jar}" GET /auth/releases)" in
  *"${release_id}"*) fail "another unit's steward does not list the request" "it was listed" ;;
  *) pass "another unit's steward does not list the request" ;;
esac

# The database refuses self-approval even if psu-auth did not.
if run_sql_as_owner "UPDATE identity.dataset_release SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE release_id = '${release_id}'" >/dev/null 2>&1; then
  fail "the database refuses self-approval" "the UPDATE succeeded"
else
  pass "the database refuses self-approval"
fi

# 4. A rejection needs a reason.
expect_status "a rejection without a reason is refused" \
  "$(call "${steward_jar}" POST "/auth/releases/${release_id}/reject" '{}')" 400

# Preview shows structure and a count, no rows.
preview="$(call "${steward_jar}" GET "/auth/releases/${release_id}/preview")"
case "${preview}" in
  "200 "*"\"org_unit\""*"\"rowCount\":3"*) pass "the owning steward previews columns and row count" ;;
  *) fail "the owning steward previews columns and row count" "${preview}" ;;
esac

# 5. The owning steward approves; the copy runs in the background.
expect_status "the owning steward approves" \
  "$(call "${steward_jar}" POST "/auth/releases/${release_id}/approve")" 202

status=""
attempt=0
while [ "${attempt}" -lt 60 ]; do
  status="$(run_sql_as_owner "SELECT status FROM identity.dataset_release WHERE release_id = '${release_id}'" | tr -d '[:space:]')"
  [ "${status}" = "approved" ] || break
  attempt=$((attempt + 1))
  sleep 2
done
[ "${status}" = "published" ] && pass "the release reaches published" \
  || fail "the release reaches published" "status ${status}, failure $(run_sql_as_owner "SELECT failure_code FROM identity.dataset_release WHERE release_id = '${release_id}'")"

# 6. The copy, the pins and the catalogue.
published_rows="$(admin_sql "SELECT count(*) FROM polaris.published.\"${table}\"" | tr -d '[:space:]')"
[ "${published_rows}" = "3" ] && pass "published holds all curated rows" \
  || fail "published holds all curated rows" "got '${published_rows}'"

pinned="$(run_sql_as_owner "SELECT (source_snapshot_id IS NOT NULL AND published_snapshot_id IS NOT NULL)::text || ':' || row_count FROM identity.dataset_release WHERE release_id = '${release_id}'" | tr -d '[:space:]')"
[ "${pinned}" = "true:3" ] && pass "the release is pinned to both snapshots with its row count" \
  || fail "the release is pinned" "got '${pinned}'"

published_snapshot="$(run_sql_as_owner "SELECT published_snapshot_id FROM identity.dataset_release WHERE release_id = '${release_id}'" | tr -d '[:space:]')"
time_travel="$(admin_sql "SELECT count(*) FROM polaris.published.\"${table}\" FOR VERSION AS OF ${published_snapshot}" | tr -d '[:space:]')"
[ "${time_travel}" = "3" ] && pass "the recorded published snapshot is readable" \
  || fail "the recorded published snapshot is readable" "got '${time_travel}'"

catalog="$(curl -s "${portal_base}/auth/catalog/releases")"
case "${catalog}" in
  *"\"${table}\""*) pass "the public catalogue lists the release" ;;
  *) fail "the public catalogue lists the release" "${catalog}" ;;
esac
for forbidden in Snapshot requested decided failure userId; do
  case "${catalog}" in
    *"${forbidden}"*) fail "the public catalogue omits ${forbidden}" "found in ${catalog}" ;;
    *) pass "the public catalogue omits ${forbidden}" ;;
  esac
done

expect_status "a decided release cannot be decided again" \
  "$(call "${steward_jar}" POST "/auth/releases/${release_id}/reject" '{"reason":"late"}')" 409

# 7. Published is written by releases only.
if MSYS_NO_PATHCONV=1 trino_sql "${analyst_trino_user}" "${analyst_trino_password}" \
     "INSERT INTO polaris.published.\"${table}\" VALUES ('eng', 1)" | grep -q "Access Denied"; then
  pass "the analyst identity cannot insert into published"
else
  fail "the analyst identity cannot insert into published" "no Access Denied"
fi
if MSYS_NO_PATHCONV=1 trino_sql "${ingestion_user}" "${ingestion_password}" \
     "INSERT INTO polaris.published.\"${table}\" VALUES ('eng', 1)" | grep -q "Access Denied"; then
  pass "the ingestion identity cannot insert into published"
else
  fail "the ingestion identity cannot insert into published" "no Access Denied"
fi

if [ "${failures}" -eq 0 ]; then
  echo "ALL RELEASE TESTS PASSED"
else
  echo "${failures} release test(s) failed" >&2
  exit 1
fi
