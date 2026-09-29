#!/bin/sh
# Provisions or updates an email-and-password portal account.
#
# There is no self-registration route: this script is the only way a
# password_hash reaches identity.app_user, and it runs as the database owner
# (psu), the same identity config/platform/migrate.sh uses -- never as
# identity_app, which is not granted permission to write that column, in
# either direction, even for its own use.
#
# A generated password is shown exactly once, on this terminal, and is not
# stored anywhere by this script. Relay it to the account holder over a
# channel your unit already trusts, the same as any other credential handoff,
# and tell them there is no in-page way to change it yet -- see
# docs/AUTH_PSU_PASSPORT_TH.md for what that implies.
#
# The account is created with access_tier = 'none': signing in is not the same
# as being granted data access. Grant a tier separately -- see the reminder
# printed at the end of this script and scripts/publish-trino-groups.sh.
#
# Every account also gets a psu_username, even though a password account has
# no PSU directory entry: it is what Trino and Superset impersonate this
# account as once a tier is granted, and identity.v_trino_groups has no other
# way to name a password account in the rendered group file. Pass one
# explicitly as the third argument, or a name is derived from the email.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

usage() {
  cat >&2 <<'USAGE'
usage: create-password-account.sh <email> <display name> [trino-username]

Creates the account if the email is new, or resets its password if the email
already has one. Prints the generated password once; nothing else prints it,
logs it, or stores it beyond the bcrypt hash written to the database.

trino-username is what this account is impersonated as in Trino once granted
a tier (config/platform/014-steward-developer-tiers.sql). Defaults to the
email's local part, lowercased and with anything outside [a-z0-9._-] replaced
by '-'. Must be unique across every account, PSU Passport ones included.
USAGE
}

email="${1:-}"
display_name="${2:-}"
trino_username="${3:-}"

if [ -z "${email}" ]; then
  usage
  exit 1
fi

case "${email}" in
  *@*.*) ;;
  *)
    echo "not an email address: ${email}" >&2
    exit 1
    ;;
esac

if [ -z "${display_name}" ]; then
  echo "a display name is required: a password account has no PSU directory entry to read one from, and the portal shows this name once signed in" >&2
  usage
  exit 1
fi

if [ -z "${trino_username}" ]; then
  local_part="${email%%@*}"
  # sh has no built-in lowercasing; tr covers the ASCII case this needs.
  trino_username="$(printf '%s' "${local_part}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-')"
fi

# case globs only test a shape, not "every character in the class" -- stripping
# the allowed characters and checking nothing is left over tests the whole
# string, and also catches an empty result (email with nothing before the @).
disallowed="$(printf '%s' "${trino_username}" | tr -d 'a-z0-9._-')"
if [ -z "${trino_username}" ] || [ -n "${disallowed}" ]; then
  echo "trino-username must be non-empty and match [a-z0-9._-]+, got: '${trino_username}'" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "no .env in ${repo_dir}" >&2
  exit 1
fi

postgres_user="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"
postgres_password="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
bcrypt_cost="$(grep '^PASSWORD_LOGIN_BCRYPT_COST=' .env | cut -d= -f2-)"
bcrypt_cost="${bcrypt_cost:-12}"

if [ -z "${postgres_user}" ] || [ -z "${postgres_password}" ]; then
  echo "POSTGRES_USER / POSTGRES_PASSWORD must be set in .env" >&2
  exit 1
fi

# Random, not operator-chosen: an administrator picking a password tends to
# pick a weak or reused one, and there is no user-facing "change password" yet
# to fix that after the fact.
generated_password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-24)"

echo "hashing the password inside the psu-auth image (same bcryptjs build the service verifies with)..." >&2
password_hash="$(docker compose --profile auth run --rm --no-deps --entrypoint node psu-auth \
  dist/tools/hash-password.js "${generated_password}" "${bcrypt_cost}" 2>/tmp/create-password-account.stderr)"

if [ -z "${password_hash}" ]; then
  echo "hashing failed:" >&2
  cat /tmp/create-password-account.stderr >&2
  rm -f /tmp/create-password-account.stderr
  exit 1
fi
rm -f /tmp/create-password-account.stderr

# A command substitution used as the condition of an if is exempt from
# set -e's normal "exit immediately on failure": that is what makes it
# possible to inspect a non-zero status here at all, rather than the script
# exiting on the assignment before this line's error handling ever ran.
if sql_output="$(docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="$0" psql --host 127.0.0.1 --username "$1" --dbname platform --quiet --no-psqlrc \
     --set email="$2" --set display_name="$3" --set password_hash="$4" --set trino_username="$5" -f -' \
  "${postgres_password}" "${postgres_user}" "${email}" "${display_name}" "${password_hash}" "${trino_username}" <<'SQL'
INSERT INTO identity.app_user (email, display_name, password_hash, psu_username)
VALUES (:'email', :'display_name', :'password_hash', :'trino_username')
ON CONFLICT (subject) DO NOTHING;

-- ON CONFLICT above only covers the subject key, which a password account has
-- none of, so a repeat run for the same email is handled here instead: update
-- in place rather than error, since resetting a lost password is the normal
-- reason to run this script twice for one address. psu_username is left
-- alone on a repeat run: changing a Trino identity a tier may already be
-- granted under is a separate, deliberate action, not a side effect of a
-- password reset.
UPDATE identity.app_user
   SET password_hash = :'password_hash',
       display_name  = :'display_name',
       is_active     = true
 WHERE lower(email) = lower(:'email');

SELECT user_id, email, psu_username, display_name, access_tier, is_active
  FROM identity.app_user
 WHERE lower(email) = lower(:'email');
SQL
)"; then
  echo "${sql_output}"
else
  echo "${sql_output}" >&2
  case "${sql_output}" in
    *app_user_psu_username_key*)
      echo "trino-username '${trino_username}' is already taken by another account -- pass a different one as the third argument" >&2
      ;;
  esac
  exit 1
fi

cat <<MSG

Generated password (shown once, not stored by this script):

    ${generated_password}

Relay it to ${email} over a channel your unit already trusts. The account
starts at access_tier 'none' -- no data access -- until an administrator
grants one. Tiers: viewer and steward need org_unit; viewer_exec and analyst
read/write without an org boundary; developer is full platform access, the
same as this deployment's own admin identity -- reserve it for your own team.

    UPDATE identity.app_user SET access_tier = 'viewer', org_unit = '<unit>'
      WHERE lower(email) = lower('${email}');
    scripts/publish-trino-groups.sh
MSG
