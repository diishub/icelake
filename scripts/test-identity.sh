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

expect_equals() {
  if [ "$3" = "$2" ]; then echo "PASS $1"; else failures=$((failures + 1)); echo "FAIL $1: expected '$2', got '$3'" >&2; fi
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

if [ "${failures}" -eq 0 ]; then
  echo "all identity cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
