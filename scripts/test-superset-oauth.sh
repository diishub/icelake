#!/bin/sh
# Assert the PSU Passport wiring for Superset behaves at the edges.
#
# The sign-in flow itself cannot be exercised without a registered OIDC client,
# so what is asserted here is everything around it: that the feature is off
# until it is turned on, that turning it on without credentials fails loudly
# rather than silently falling back to local passwords, that the security
# manager refuses a username it cannot render into a Trino group, and that
# signing in grants no data on its own.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

failures=0
pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1" >&2; }

expect_equals() {
  if [ "$3" = "$2" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}

run_superset_python() {
  docker compose run --rm --no-deps -T "$@" superset python - 2>&1
}

# ---------------------------------------------------------------------------
# Off by default
# ---------------------------------------------------------------------------

default_auth="$(printf '%s\n' \
  'import superset_config as c' \
  'print("oauth" if getattr(c, "SUPERSET_OAUTH_ENABLED", False) else "db")' \
  | run_superset_python -e SUPERSET_OAUTH_ENABLED=false | tail -1)"
expect_equals "sign-in stays on local accounts until it is switched on" "db" "${default_auth}"

# ---------------------------------------------------------------------------
# On, but unconfigured, must fail loudly
# ---------------------------------------------------------------------------
#
# The failure mode that matters is the quiet one: OAuth switched on, no client
# configured, and Superset happily serving the password form as though nothing
# were wrong.

unconfigured="$(printf '%s\n' \
  'try:' \
  '    import superset_config' \
  '    print("accepted")' \
  'except Exception as error:' \
  '    print("refused" if "SUPERSET_OAUTH_CLIENT_ID" in str(error) else f"other: {error}")' \
  | run_superset_python -e SUPERSET_OAUTH_ENABLED=true \
      -e SUPERSET_OAUTH_ISSUER=https://passport.invalid/realms/psu | tail -1)"
expect_equals "switching sign-in on without a client refuses to start" "refused" "${unconfigured}"

# ---------------------------------------------------------------------------
# Usernames that cannot become a Trino group are refused
# ---------------------------------------------------------------------------

username_cases="$(printf '%s\n' \
  'from psu_security_manager import USERNAME_PATTERN, _psu_username' \
  'good = _psu_username("Somchai.K@psu.ac.th")' \
  'bad = _psu_username("some one@psu.ac.th")' \
  'print(f"{good}|{bool(USERNAME_PATTERN.match(good))}|{bool(USERNAME_PATTERN.match(bad))}")' \
  | run_superset_python | tail -1)"
expect_equals "the bare username is accepted and a malformed one is not" \
  "somchai.k|True|False" "${username_cases}"

# ---------------------------------------------------------------------------
# Signing in grants nothing
# ---------------------------------------------------------------------------

identity_password="$(grep '^IDENTITY_DB_PASSWORD=' .env | cut -d= -f2-)"
as_identity() {
  docker compose exec -T -e PGPASSWORD="${identity_password}" postgres \
    psql --host 127.0.0.1 --username identity_app --dbname platform \
      --no-align --tuples-only --quiet --no-psqlrc -f - 2>&1
}

printf "%s\n" "INSERT INTO identity.app_user (subject, psu_username, display_name)
  VALUES ('SYNTHETIC-SUBJECT-OAUTH', 'synthetic.oauth', 'Synthetic OAuth')
  ON CONFLICT (subject) DO NOTHING;" | as_identity >/dev/null

expect_equals "a new account is granted no data access" "none" \
  "$(printf "SELECT access_tier FROM identity.app_user WHERE subject = 'SYNTHETIC-SUBJECT-OAUTH';\n" | as_identity)"

expect_equals "an account with no grant appears in no Trino group" "0" \
  "$(printf "SELECT count(*) FROM identity.v_trino_groups WHERE username = 'synthetic.oauth';\n" | as_identity)"

case "$(printf "UPDATE identity.app_user SET access_tier = 'analyst' WHERE subject = 'SYNTHETIC-SUBJECT-OAUTH';\n" | as_identity)" in
  *"permission denied"*|*ERROR*) pass "the sign-in service cannot grant itself data access" ;;
  *) fail "the sign-in service cannot grant itself data access: the statement was accepted" ;;
esac

docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --quiet --no-psqlrc -c "DELETE FROM identity.app_user WHERE subject = '"'"'SYNTHETIC-SUBJECT-OAUTH'"'"'"' >/dev/null 2>&1

if [ "${failures}" -eq 0 ]; then
  echo "all Superset sign-in cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
