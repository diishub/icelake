#!/bin/sh
# Prove Trino now requires a credential rather than believing a claim.
#
# Until this landed, any client that could reach the port could send
# X-Trino-User: psu-admin and be treated as an administrator. That is the
# single reason the stack could not be pointed at real data, and it is what
# made the earlier exposure as serious as it was, so it gets its own test.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

admin_user="$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)"
admin_password="$(trino_password_for PSU_ADMIN_PASSWORD)"
analyst_user="$(grep '^PSU_ANALYST_USERNAME=' .env | cut -d= -f2)"
analyst_password="$(trino_password_for PSU_ANALYST_PASSWORD)"
failures=0

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }

# Raw HTTP, so the transport-level behaviour is visible rather than hidden
# behind whatever the CLI decides to do.
http_status() {
  docker compose exec -T trino curl --silent --output /dev/null --write-out '%{http_code}' \
    --insecure "$@" 2>/dev/null
}

status="$(http_status -H 'X-Trino-User: '"${admin_user}" -X POST -d 'SELECT 1' https://trino:8443/v1/statement)"
[ "${status}" = "401" ] && pass "an asserted username with no credential is rejected" \
  || fail "an asserted username with no credential is rejected" "got HTTP ${status}"

status="$(http_status -H 'X-Trino-User: '"${admin_user}" -X POST -d 'SELECT 1' http://localhost:8080/v1/statement)"
case "${status}" in
  40*) pass "the plain HTTP port cannot be used to bypass the authenticator" ;;
  *)   fail "the plain HTTP port cannot be used to bypass the authenticator" "got HTTP ${status}" ;;
esac

body="$(docker compose exec -T trino curl --silent --insecure \
  -u "${admin_user}:definitely-not-the-password" -X POST -d 'SELECT 1' \
  https://localhost:8443/v1/statement 2>/dev/null)"
case "${body}" in
  *"Invalid credentials"*) pass "a wrong password is rejected" ;;
  *) fail "a wrong password is rejected" "got: ${body}" ;;
esac

result="$(trino_sql "${admin_user}" "${admin_password}" 'SELECT current_user')"
case "${result}" in
  *"${admin_user}"*) pass "a correct credential authenticates as that identity" ;;
  *) fail "a correct credential authenticates as that identity" "got: ${result}" ;;
esac

# Borrowing another identity requires that identity's password, so a leaked
# analyst credential does not become an administrator credential.
result="$(trino_sql "${admin_user}" "${analyst_password}" 'SELECT 1' || true)"
case "${result}" in
  *"Invalid credentials"*) pass "one identity cannot log in with another password" ;;
  *) fail "one identity cannot log in with another password" "got: ${result}" ;;
esac

# Impersonation stays available to Superset alone: it is how the BI layer
# carries the signed-in user through to the policy. The check has to follow
# the query to completion -- Trino accepts the submission first and reports
# the authorization failure on a later poll.
result="$(docker compose exec -T nifi /bin/sh -ec '
  user="$1"; password="$2"; target="$3"
  body="$(curl -sk -u "${user}:${password}" -H "X-Trino-User: ${target}" \
    -X POST -d "SELECT 1" https://trino:8443/v1/statement)"
  attempt=0
  while [ "${attempt}" -lt 15 ]; do
    error="$(printf "%s" "${body}" | jq -r ".error.message // empty")"
    [ -n "${error}" ] && { printf "%s" "${error}"; exit 0; }
    next="$(printf "%s" "${body}" | jq -r ".nextUri // empty")"
    [ -z "${next}" ] && { printf "completed"; exit 0; }
    body="$(curl -sk -u "${user}:${password}" "${next}")"
    attempt=$((attempt + 1))
  done
  printf "timed out"
' _ "${analyst_user}" "${analyst_password}" "${admin_user}" 2>/dev/null)"
case "${result}" in
  *"Access Denied"*|*"annot impersonate"*) pass "a normal identity cannot impersonate another user" ;;
  *) fail "a normal identity cannot impersonate another user" "got: ${result}" ;;
esac

if [ "${failures}" -ne 0 ]; then
  echo "${failures} Trino authentication test(s) failed" >&2
  exit 1
fi
echo "All Trino authentication tests passed"
