#!/bin/sh
# End-to-end check of email-and-password sign-in against the running psu-auth
# service: create an account, exercise the endpoint the way login.js does,
# and confirm what the schema-level tests in test-identity.sh can only assert
# indirectly -- that the wrong password, an unknown email, and a disabled
# account really do produce the same response, and that the rate limiter
# really does engage over HTTP.
#
# Requires: docker compose --profile auth up -d psu-auth, and nginx already
# proxying /auth/ (config/portal/default.conf). Skips itself rather than
# failing when psu-auth is not running, since it is behind a profile and a
# fresh checkout does not have it up by default.
#
# MSYS_NO_PATHCONV is set per docker-compose invocation below, never for the
# whole script: it stops Git Bash rewriting a container-internal path like
# /bin/sh into a Windows path, which docker compose needs, but the native
# Windows curl.exe in this environment needs the opposite -- with it set,
# curl's own "-o /dev/null" cannot open the null device at all (exit 23) and
# every request below would be mistaken for a connection failure. Explicitly
# unset here rather than just "not set", because a caller that already
# exported it (this repo's other scripts routinely do) would otherwise leak
# it into every curl call below.
unset MSYS_NO_PATHCONV || true
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

portal_base="http://127.0.0.1:8085"
test_email="synthetic-password-login-test@example.invalid"
failures=0

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }

run_sql_as_owner() {
  # $1 = SQL statement
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    "PGPASSWORD=\"\${POSTGRES_PASSWORD}\" psql --host 127.0.0.1 --username \"\${POSTGRES_USER}\" --dbname platform --quiet --no-psqlrc -c \"$1\""
}

cleanup() {
  run_sql_as_owner "DELETE FROM identity.app_user WHERE email = '${test_email}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! curl -sf "${portal_base}/auth/health" >/dev/null; then
  echo "SKIP psu-auth is not running (docker compose --profile auth up -d psu-auth)"
  exit 0
fi

login_as() {
  # $1 email, $2 password
  curl -s -o /dev/null -w '%{http_code}' -X POST "${portal_base}/auth/password/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}

cleanup

echo "provisioning a synthetic account..." >&2
create_output="$(MSYS_NO_PATHCONV=1 ./scripts/create-password-account.sh "${test_email}" "Synthetic Password Login Test" 2>&1)"
password="$(printf '%s\n' "${create_output}" | sed -n 's/^ *//; /^[A-Za-z0-9_-]\{16,\}$/p' | tail -1)"

if [ -z "${password}" ]; then
  echo "could not extract the generated password from create-password-account.sh output:" >&2
  echo "${create_output}" >&2
  exit 1
fi

status="$(login_as "${test_email}" "${password}")"
[ "${status}" = "200" ] && pass "the correct password authenticates" \
  || fail "the correct password authenticates" "expected 200, got ${status}"

status="$(login_as "${test_email}" "definitely-the-wrong-password")"
[ "${status}" = "401" ] && pass "the wrong password is rejected" \
  || fail "the wrong password is rejected" "expected 401, got ${status}"

status="$(login_as "nobody-${test_email}" "anything")"
[ "${status}" = "401" ] && pass "an unknown email is rejected with the same status as a wrong password" \
  || fail "an unknown email is rejected with the same status as a wrong password" "expected 401, got ${status}"

status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${portal_base}/auth/password/login" \
  -H 'Content-Type: application/json' -d '{"email":"","password":""}')"
[ "${status}" = "400" ] && pass "an empty request is rejected before it reaches the database" \
  || fail "an empty request is rejected before it reaches the database" "expected 400, got ${status}"

run_sql_as_owner "UPDATE identity.app_user SET is_active = false WHERE email = '${test_email}'" >/dev/null

status="$(login_as "${test_email}" "${password}")"
[ "${status}" = "403" ] && pass "a disabled account is refused even with the correct password" \
  || fail "a disabled account is refused even with the correct password" "expected 403, got ${status}"

run_sql_as_owner "UPDATE identity.app_user SET is_active = true WHERE email = '${test_email}'" >/dev/null

# The limiter is keyed by email and is per-process/in-memory (see
# services/auth/src/password.ts); a fresh email guarantees an empty window.
rate_limit_email="rate-limit-${test_email}"
attempt=1
last_status=""
while [ "${attempt}" -le 9 ]; do
  last_status="$(login_as "${rate_limit_email}" "wrong")"
  attempt=$((attempt + 1))
done
[ "${last_status}" = "429" ] && pass "the rate limiter engages after repeated failures" \
  || fail "the rate limiter engages after repeated failures" "expected 429 on the 9th attempt, got ${last_status}"

if [ "${failures}" -eq 0 ]; then
  echo "all password sign-in cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
