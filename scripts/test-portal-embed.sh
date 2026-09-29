#!/bin/sh
# Asserts the access-tier gate on /auth/embeds/ops, the guest-token route
# viewer_exec/analyst accounts use to see a Superset dashboard inline instead
# of a second Superset login (services/auth/src/server.ts).
#
# The full happy path (a real 200 with a working guest token) needs
# SUPERSET_OPS_DASHBOARD_EMBED_UUID, which config/superset/bootstrap_embed.py
# prints once per install and an operator copies into .env -- CI does not do
# that copy, the same reason test-superset-oauth.sh cannot exercise a real
# PSU Passport sign-in either. What is asserted here is everything around
# that: no session is refused, the wrong tier is refused, and -- when this
# machine does have the embed configured -- a permitted tier gets a real
# token back rather than a silent failure.
unset MSYS_NO_PATHCONV || true
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

portal_base="http://127.0.0.1:8085"
test_email="synthetic-embed-test@example.invalid"
failures=0

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }

run_sql_as_owner() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc -c \"$1\""
}

jar="$(mktemp)"
cleanup() {
  rm -f "${jar}"
  run_sql_as_owner "DELETE FROM identity.app_user WHERE email = '${test_email}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! curl -sf "${portal_base}/auth/health" >/dev/null; then
  echo "SKIP psu-auth is not running (docker compose --profile auth up -d psu-auth)"
  exit 0
fi

cleanup >/dev/null 2>&1 || true

status="$(curl -s -o /dev/null -w '%{http_code}' "${portal_base}/auth/embeds/ops")"
[ "${status}" = "401" ] && pass "no session is refused" \
  || fail "no session is refused" "expected 401, got ${status}"

echo "provisioning a synthetic steward-tier account (wrong tier for this route)..." >&2
create_output="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${test_email}" "Synthetic Embed Test" 2>&1)"
password="$(printf '%s\n' "${create_output}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"
if [ -z "${password}" ]; then
  echo "could not extract the generated password from create-password-account.sh output:" >&2
  echo "${create_output}" >&2
  exit 1
fi
run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'steward', org_unit = 'eng' WHERE email = '${test_email}'" >/dev/null

curl -s -o /dev/null -c "${jar}" -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${test_email}\",\"password\":\"${password}\"}"

status="$(curl -s -o /dev/null -w '%{http_code}' -b "${jar}" "${portal_base}/auth/embeds/ops")"
[ "${status}" = "403" ] && pass "a tier with no embed permission (steward) is refused" \
  || fail "a tier with no embed permission (steward) is refused" "expected 403, got ${status}"

run_sql_as_owner "UPDATE identity.app_user SET access_tier = 'analyst', org_unit = NULL WHERE email = '${test_email}'" >/dev/null

response="$(curl -s -w '\n%{http_code}' -b "${jar}" "${portal_base}/auth/embeds/ops")"
status="$(printf '%s' "${response}" | tail -1)"
body="$(printf '%s' "${response}" | sed '$d')"
case "${status}" in
  200)
    case "${body}" in
      *'"guestToken"'*) pass "a permitted tier (analyst) receives a guest token" ;;
      *) fail "a permitted tier (analyst) receives a guest token" "200 but no guestToken field: ${body}" ;;
    esac
    ;;
  503)
    echo "SKIP embedding is not configured on this machine (SUPERSET_OPS_DASHBOARD_EMBED_UUID unset -- see config/superset/bootstrap_embed.py)" >&2
    ;;
  *)
    fail "a permitted tier (analyst) receives a guest token" "expected 200 or 503, got ${status}"
    ;;
esac

if [ "${failures}" -eq 0 ]; then
  echo "all portal embed cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
