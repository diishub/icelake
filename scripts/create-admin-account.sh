#!/bin/sh
# Provisions the portal's first admin -- or any later one -- from the host.
#
# An admin manages accounts on the portal's admin page: creates password
# accounts, grants and revokes tiers, switches accounts off and resets
# passwords (config/platform/022-admin-tier.sql). The portal cannot create the
# first admin for itself, so this script does, as the database owner.
#
# It is create-password-account.sh followed by a grant of the 'admin' tier.
# Run again for the same email to reset that admin's password; the tier is
# re-applied, the Trino identity is left as it was.
#
# The grant is recorded in identity.admin_event with no actor, which is how
# the audit trail shows a change made from the host rather than the portal.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

if [ $# -lt 2 ]; then
  echo 'usage: create-admin-account.sh <email> "<display name>" [trino-username]' >&2
  exit 1
fi

email="$1"

./scripts/create-password-account.sh "$@"

postgres_user="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"
postgres_password="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"

docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="$0" psql --host 127.0.0.1 --username "$1" --dbname platform --quiet --no-psqlrc \
     --set ON_ERROR_STOP=1 --set email="$2" -f -' \
  "${postgres_password}" "${postgres_user}" "${email}" <<'SQL'
WITH target AS (
  SELECT user_id, access_tier, org_unit, is_active
    FROM identity.app_user
   WHERE lower(email) = lower(:'email')
), granted AS (
  UPDATE identity.app_user AS u
     SET access_tier = 'admin', org_unit = NULL, is_active = true
    FROM target
   WHERE u.user_id = target.user_id
  RETURNING u.user_id
)
INSERT INTO identity.admin_event (actor_user_id, target_user_id, action, detail)
SELECT NULL, target.user_id, 'account_updated',
       jsonb_build_object(
         'before', jsonb_build_object('access_tier', target.access_tier, 'org_unit', target.org_unit,
                                      'is_active', target.is_active),
         'after',  jsonb_build_object('access_tier', 'admin', 'org_unit', NULL, 'is_active', true),
         'via', 'scripts/create-admin-account.sh')
  FROM target JOIN granted USING (user_id);
SQL

cat <<MSG

${email} is now an admin. Sign in at the portal and open /admin.html to
manage accounts. The trino-groups-sync service picks up the new grant within
a few seconds; run scripts/publish-trino-groups.sh if it is not running.

Ignore the access_tier reminder printed above: the 'admin' tier has been
granted already.
MSG
