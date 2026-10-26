#!/bin/sh
# Render the Trino group file from both sources of identity, now.
#
# Two things decide who is in which Trino group:
#   * the development identities in .env, rendered by
#     config/trino/render-groups.sh as they always were
#   * portal accounts that have been granted a tier, by an admin in the portal
#     or by an UPDATE on the host, read from identity.v_trino_groups
#
# Signing in grants nothing on its own. An account sits at tier 'none' and does
# not appear in this file at all until someone records a grant, so the default
# for a new PSU account is no data, not the widest view.
#
# The trino-groups-sync service already does this every few seconds, so this
# script is only needed when that service is not running or a change must be
# visible before its next pass. Both run the same merge
# (config/trino/sync-trino-groups.sh), so they cannot disagree.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

if [ ! -f .env ]; then
  echo "no .env in ${repo_dir}" >&2
  exit 1
fi

docker compose run --rm --no-deps trino-groups-sync /bootstrap/sync-trino-groups.sh once
echo "rendered runtime/trino/groups.txt"
