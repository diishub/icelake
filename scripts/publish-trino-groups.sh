#!/bin/sh
# Render the Trino group file from both sources of identity.
#
# Two things decide who is in which Trino group:
#   * the development identities in .env, rendered by
#     config/trino/render-groups.sh as they always were
#   * accounts that signed in through PSU Passport and have since been granted
#     a tier by an administrator, read from identity.v_trino_groups
#
# Signing in grants nothing on its own. An account sits at tier 'none' and does
# not appear in this file at all until someone records a grant, so the default
# for a new PSU account is no data, not the widest view.
#
# Trino re-reads the file every five seconds (file.refresh-period in
# config/trino/group-provider.properties), so a grant takes effect without a
# restart and a revocation takes effect just as fast.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

group_file="runtime/trino/groups.txt"
scratch="${group_file}.tmp"

if [ ! -f .env ]; then
  echo "no .env in ${repo_dir}" >&2
  exit 1
fi

# The development identities first, into the file the group provider reads.
docker compose run --rm dev-identity-setup >/dev/null

if [ ! -s "${group_file}" ]; then
  echo "dev-identity-setup produced no group file" >&2
  exit 1
fi

identity_password="$(grep '^IDENTITY_DB_PASSWORD=' .env | cut -d= -f2-)"
if [ -z "${identity_password}" ]; then
  echo "IDENTITY_DB_PASSWORD is not set in .env" >&2
  exit 1
fi

# One "group username" line per grant, which is the shape the merge below
# expects. A tier of 'none' is excluded by the view, not filtered here.
grants="$(printf "%s\n" \
  "SELECT g.group_name || ' ' || v.username
     FROM identity.v_trino_groups AS v
     CROSS JOIN LATERAL unnest(v.trino_groups) AS g(group_name)
    ORDER BY 1;" \
  | docker compose exec -T -e PGPASSWORD="${identity_password}" postgres \
      psql --host 127.0.0.1 --username identity_app --dbname platform \
        --no-align --tuples-only --quiet --no-psqlrc -f - | tr -d '\r')"

# Merge: each granted username is appended to its group's existing member list,
# and a group that only single sign-on accounts belong to is added as a new
# line. Done in awk rather than by appending duplicate lines, because the file
# group provider reads one line per group and a second line for the same group
# replaces the first rather than extending it.
awk -v grants="${grants}" '
  BEGIN {
    n = split(grants, rows, "\n")
    for (i = 1; i <= n; i++) {
      if (rows[i] == "") continue
      split(rows[i], parts, " ")
      group = parts[1]; member = parts[2]
      if (group == "" || member == "") continue
      extra[group] = (group in extra) ? extra[group] "," member : member
      order[++count] = (group in seen) ? "" : group
      seen[group] = 1
    }
  }
  {
    line = $0
    colon = index(line, ":")
    if (colon > 0) {
      group = substr(line, 1, colon - 1)
      if (group in extra) {
        members = substr(line, colon + 1)
        print group ":" (members == "" ? extra[group] : members "," extra[group])
        done[group] = 1
        next
      }
    }
    print line
  }
  END {
    for (i = 1; i <= count; i++) {
      group = order[i]
      if (group != "" && !(group in done)) {
        print group ":" extra[group]
      }
    }
  }
' "${group_file}" > "${scratch}"

mv "${scratch}" "${group_file}"

granted="$(printf "%s\n" "${grants}" | grep -c . || true)"
echo "rendered ${group_file}: development identities plus ${granted} single sign-on grant(s)"
