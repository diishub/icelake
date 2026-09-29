#!/bin/sh
# Assert the identity store holds what it claims and refuses what it must.
#
# The cases that matter are the boundaries: the sign-in service cannot erase
# its own audit trail, cannot be handed a group the portal has never heard of,
# the ingestion identity cannot read who signed in, and the retention rule is
# something the database actually does rather than something a document says.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

identity_password="$(grep '^IDENTITY_DB_PASSWORD=' .env | cut -d= -f2-)"
platform_password="$(grep '^PLATFORM_DB_PASSWORD=' .env | cut -d= -f2-)"
failures=0

as_identity() {
  docker compose exec -T -e PGPASSWORD="${identity_password}" postgres \
    psql --host 127.0.0.1 --username identity_app --dbname platform \
      --no-align --tuples-only --quiet --no-psqlrc -f - 2>&1
}

as_pipeline() {
  docker compose exec -T -e PGPASSWORD="${platform_password}" postgres \
    psql --host 127.0.0.1 --username platform_app --dbname platform \
      --no-align --tuples-only --quiet --no-psqlrc -f - 2>&1
}

# Runs SQL as the database owner. Only used for teardown and for cases about
# a constraint itself rather than about a role's privileges: provisioning an
# email-and-password account runs as this identity in production too --
# scripts/create-password-account.sh, never as identity_app.
as_owner() {
  docker compose exec -T postgres /bin/sh -ec \
    'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" \
       --dbname platform --no-align --tuples-only --quiet --no-psqlrc -f -' 2>&1
}

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }

expect_equals() {
  if [ "$3" = "$2" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}

expect_refused() {
  case "$2" in
    *"permission denied"*|*ERROR*) echo "PASS $1" ;;
    *) failures=$((failures + 1)); echo "FAIL $1: the statement was accepted" >&2 ;;
  esac
}

# A throwaway account the later cases operate on. The subject and username are
# obviously synthetic so a stray row is never mistaken for a real person.
printf "%s\n" "INSERT INTO identity.app_user (subject, psu_username, display_name)
  VALUES ('SYNTHETIC-SUBJECT-TEST', 'synthetic-test-user', 'Synthetic Test')
  ON CONFLICT (subject) DO NOTHING;" | as_identity >/dev/null

expect_equals "the sign-in service can create an account" "1" \
  "$(printf "SELECT count(*) FROM identity.app_user WHERE subject = 'SYNTHETIC-SUBJECT-TEST';\n" | as_identity)"

expect_equals "a new account starts with no confirmed group" "unknown" \
  "$(printf "SELECT user_type FROM identity.app_user WHERE subject = 'SYNTHETIC-SUBJECT-TEST';\n" | as_identity)"

expect_refused "an unknown user type is rejected" \
  "$(printf "UPDATE identity.app_user SET user_type = 'lecturer' WHERE subject = 'SYNTHETIC-SUBJECT-TEST';\n" | as_identity)"

expect_refused "an unknown login reason is rejected" \
  "$(printf "INSERT INTO identity.login_event (outcome, reason) VALUES ('succeeded', 'because');\n" | as_identity)"

expect_refused "the sign-in service cannot delete its audit trail" \
  "$(printf "DELETE FROM identity.login_event;\n" | as_identity)"

expect_refused "the sign-in service cannot delete an account" \
  "$(printf "DELETE FROM identity.app_user WHERE subject = 'SYNTHETIC-SUBJECT-TEST';\n" | as_identity)"

expect_refused "the ingestion identity cannot read who signed in" \
  "$(printf "SELECT count(*) FROM identity.app_user;\n" | as_pipeline)"

# A session that is already expired must not resolve, and the retention
# function must be the thing that removes it.
printf "%s\n" "INSERT INTO identity.user_session (session_hash, user_id, created_at, expires_at)
  SELECT 'synthetic-expired-session', user_id, now() - interval '2 hours', now() - interval '1 hour'
    FROM identity.app_user WHERE subject = 'SYNTHETIC-SUBJECT-TEST'
  ON CONFLICT (session_hash) DO NOTHING;" | as_identity >/dev/null

expect_equals "an expired session never resolves to an account" "0" \
  "$(printf "SELECT count(*) FROM identity.user_session s JOIN identity.app_user u USING (user_id)
     WHERE s.session_hash = 'synthetic-expired-session' AND s.expires_at > now();\n" | as_identity)"

printf "SELECT 1 FROM identity.purge_expired();\n" | as_identity >/dev/null

expect_equals "retention removes the expired session" "0" \
  "$(printf "SELECT count(*) FROM identity.user_session WHERE session_hash = 'synthetic-expired-session';\n" | as_identity)"

# Clean up as the owner, since the sign-in role deliberately cannot.
docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --quiet --no-psqlrc -c "DELETE FROM identity.app_user WHERE subject = '"'"'SYNTHETIC-SUBJECT-TEST'"'"'"' >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Email-and-password sign-in
# ---------------------------------------------------------------------------
#
# Provisioning itself runs as the database owner (scripts/create-password-account.sh
# does the same), so these constraint checks run as_owner too; the role checks
# below assert what identity_app specifically may and may not do with a
# password hash.

expect_refused "a password-only account needs at least one auth method" \
  "$(printf "INSERT INTO identity.app_user (email, display_name) VALUES ('synthetic-noauth@example.invalid', 'No Auth Method');\n" | as_owner)"

printf "%s\n" "INSERT INTO identity.app_user (email, display_name, password_hash)
  VALUES ('synthetic-pw@example.invalid', 'Synthetic Password Account', '\$2a\$04\$abcdefghijklmnopqrstuuJXQxvHF3v1v1v1v1v1v1v1v1v1v1v1v');" | as_owner >/dev/null

expect_equals "a password-only account can be created with no subject or PSU username" "1" \
  "$(printf "SELECT count(*) FROM identity.app_user
     WHERE email = 'synthetic-pw@example.invalid' AND subject IS NULL AND psu_username IS NULL;\n" | as_owner)"

expect_equals "a new password account is granted no data access, same as a new PSU Passport account" "none" \
  "$(printf "SELECT access_tier FROM identity.app_user WHERE email = 'synthetic-pw@example.invalid';\n" | as_owner)"

expect_refused "email must be unique, case-insensitively" \
  "$(printf "INSERT INTO identity.app_user (email, display_name, password_hash)
       VALUES ('Synthetic-PW@example.invalid', 'Duplicate', '\$2a\$04\$zzzzzzzzzzzzzzzzzzzzzuJXQxvHF3v1v1v1v1v1v1v1v1v1v1v1v');\n" | as_owner)"

expect_refused "the sign-in service cannot write a password hash" \
  "$(printf "UPDATE identity.app_user SET password_hash = 'nope' WHERE email = 'synthetic-pw@example.invalid';\n" | as_identity)"

expect_refused "the sign-in service cannot create a password-only account" \
  "$(printf "INSERT INTO identity.app_user (email, display_name, password_hash)
       VALUES ('synthetic-pw-2@example.invalid', 'Should Be Refused', '\$2a\$04\$abcdefghijklmnopqrstuuJXQxvHF3v1v1v1v1v1v1v1v1v1v1v1v');\n" | as_identity)"

expect_equals "the sign-in service can still read a password hash, to verify one" "synthetic-pw@example.invalid" \
  "$(printf "SELECT email FROM identity.app_user WHERE email = 'synthetic-pw@example.invalid' AND password_hash IS NOT NULL;\n" | as_identity)"

# identity_app can INSERT into login_event but, deliberately, cannot SELECT
# from it -- an append-only audit log the writer cannot read back matches the
# "cannot delete its audit trail" case above. So the insert's own success is
# the check; confirming what actually landed runs as the owner, scoped by
# event_id rather than by a time window, since the table already carries rows
# from every earlier run of this script and from real sign-in attempts.
last_id_before="$(printf "SELECT COALESCE(max(event_id), 0) FROM identity.login_event;\n" | as_owner)"

for reason in invalid_credentials rate_limited; do
  insert_result="$(printf "INSERT INTO identity.login_event (outcome, reason) VALUES ('denied', '%s');\n" "${reason}" | as_identity)"
  case "${insert_result}" in
    *ERROR*) fail "login_event accepts the reason ${reason}" "${insert_result}" ;;
    *) pass "login_event accepts the reason ${reason}" ;;
  esac
done

expect_equals "both new reasons were recorded and nothing else" "invalid_credentials rate_limited" \
  "$(printf "SELECT string_agg(reason, ' ' ORDER BY event_id) FROM identity.login_event WHERE event_id > %s;\n" "${last_id_before}" | as_owner)"

docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --quiet --no-psqlrc -c "DELETE FROM identity.app_user WHERE email IN ('"'"'synthetic-pw@example.invalid'"'"', '"'"'synthetic-noauth@example.invalid'"'"')"' >/dev/null 2>&1

# ---------------------------------------------------------------------------
# steward and developer tiers (config/platform/014-steward-developer-tiers.sql)
# ---------------------------------------------------------------------------
#
# A password account needs a psu_username before it can be granted anything,
# because that column is what identity.v_trino_groups renders into the group
# file -- the gap this migration closed. steward additionally needs org_unit,
# the same rule viewer already had, now covering both.

printf "%s\n" "INSERT INTO identity.app_user (email, display_name, password_hash, psu_username)
  VALUES ('synthetic-tier-test@example.invalid', 'Synthetic Tier Test',
          '\$2a\$04\$abcdefghijklmnopqrstuuJXQxvHF3v1v1v1v1v1v1v1v1v1v1v1v',
          'synthetic-tier-test');" | as_owner >/dev/null

expect_refused "granting a tier to a password account with no psu_username is refused" \
  "$(printf "INSERT INTO identity.app_user (email, display_name, password_hash, access_tier)
       VALUES ('synthetic-no-trino-name@example.invalid', 'No Trino Name',
               '\$2a\$04\$abcdefghijklmnopqrstuuJXQxvHF3v1v1v1v1v1v1v1v1v1v1v1v', 'analyst');\n" | as_owner)"

expect_refused "steward needs an org_unit, the same as viewer" \
  "$(printf "UPDATE identity.app_user SET access_tier = 'steward' WHERE email = 'synthetic-tier-test@example.invalid';\n" | as_owner)"

printf "%s\n" "UPDATE identity.app_user SET access_tier = 'steward', org_unit = 'eng'
  WHERE email = 'synthetic-tier-test@example.invalid';" | as_owner >/dev/null

expect_equals "steward with an org_unit is accepted and rendered into its own Trino group" "psu_steward,psu_steward_org_eng" \
  "$(printf "SELECT array_to_string(trino_groups, ',') FROM identity.v_trino_groups
       WHERE username = 'synthetic-tier-test';\n" | as_owner)"

printf "%s\n" "UPDATE identity.app_user SET access_tier = 'developer', org_unit = NULL
  WHERE email = 'synthetic-tier-test@example.invalid';" | as_owner >/dev/null

expect_equals "developer is rendered into the same Trino group the platform admin identity uses" "psu_admin" \
  "$(printf "SELECT array_to_string(trino_groups, ',') FROM identity.v_trino_groups
       WHERE username = 'synthetic-tier-test';\n" | as_owner)"

expect_refused "an unknown access tier is still rejected" \
  "$(printf "UPDATE identity.app_user SET access_tier = 'superuser' WHERE email = 'synthetic-tier-test@example.invalid';\n" | as_owner)"

docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname platform \
     --quiet --no-psqlrc -c "DELETE FROM identity.app_user WHERE email = '"'"'synthetic-tier-test@example.invalid'"'"'"' >/dev/null 2>&1

if [ "${failures}" -eq 0 ]; then
  echo "all identity cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
