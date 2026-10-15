#!/bin/sh
# Keeps the Trino group file in step with the portal's access grants.
#
#   sync-trino-groups.sh loop   -- long-running (the trino-groups-sync service)
#   sync-trino-groups.sh once   -- one pass, exit non-zero on failure
#                                  (scripts/publish-trino-groups.sh)
#
# Two sources decide who is in which Trino group:
#   * the development and service identities in .env, rendered by
#     render-groups.sh exactly as dev-identity-setup renders them
#   * portal accounts with a granted tier, read from identity.v_trino_groups
#     as identity_app -- which is what an admin changes from the portal
#
# Trino re-reads the file every five seconds (config/trino/group-provider.properties),
# so a grant or revocation made in the portal reaches Trino within one sync
# interval plus that. The file is only replaced when its content changes, and
# always by rename, so Trino never reads a half-written file.
#
# A portal account whose username is already one of the .env identities is
# left out of the merge, not appended: appending it would put that account in
# every group the .env identity belongs to, psu_admin included.
set -eu

mode="${1:-loop}"
interval="${TRINO_GROUPS_SYNC_SECONDS:-10}"
output_dir="/output"
base_file="${output_dir}/groups.base.txt"
group_file="${output_dir}/groups.txt"

: "${IDENTITY_DB_PASSWORD:?IDENTITY_DB_PASSWORD must be set for the identity_app role}"

sync_once() {
  GROUP_FILE="${base_file}" /bootstrap/render-groups.sh >/dev/null

  if ! grants="$(PGPASSWORD="${IDENTITY_DB_PASSWORD}" psql \
      --host "${PGHOST:-postgres}" --username identity_app --dbname platform \
      --no-align --tuples-only --quiet --no-psqlrc --set ON_ERROR_STOP=1 \
      --command "SELECT g.group_name || ' ' || v.username
                   FROM identity.v_trino_groups AS v
                   CROSS JOIN LATERAL unnest(v.trino_groups) AS g(group_name)
                  ORDER BY 1")"; then
    echo "could not read identity.v_trino_groups; leaving ${group_file} as it is" >&2
    return 1
  fi

  # Each granted username is appended to its group's existing member list,
  # and a group only portal accounts belong to becomes a new line. The file
  # group provider reads one line per group, so a second line for the same
  # group would replace the first rather than extend it.
  awk -v grants="${grants}" '
    BEGIN {
      n = split(grants, rows, "\n")
    }
    FNR == NR {
      base[++base_count] = $0
      colon = index($0, ":")
      if (colon > 0) {
        m = split(substr($0, colon + 1), members, ",")
        for (j = 1; j <= m; j++) reserved[members[j]] = 1
      }
      next
    }
    END {
      for (i = 1; i <= n; i++) {
        if (rows[i] == "") continue
        split(rows[i], parts, " ")
        group = parts[1]; member = parts[2]
        if (group == "" || member == "") continue
        if (member in reserved) {
          print "skipping portal account \"" member "\": the username belongs to an .env identity" > "/dev/stderr"
          continue
        }
        if (!(group in extra)) order[++count] = group
        extra[group] = (group in extra) ? extra[group] "," member : member
      }
      for (i = 1; i <= base_count; i++) {
        line = base[i]
        colon = index(line, ":")
        group = colon > 0 ? substr(line, 1, colon - 1) : ""
        if (group != "" && (group in extra)) {
          members = substr(line, colon + 1)
          print group ":" (members == "" ? extra[group] : members "," extra[group])
          done[group] = 1
        } else {
          print line
        }
      }
      for (i = 1; i <= count; i++) {
        if (!(order[i] in done)) print order[i] ":" extra[order[i]]
      }
    }
  ' "${base_file}" /dev/null > "${group_file}.next"

  if cmp -s "${group_file}.next" "${group_file}"; then
    rm -f "${group_file}.next"
    return 0
  fi
  mv "${group_file}.next" "${group_file}"
  granted="$(printf '%s\n' "${grants}" | grep -c . || true)"
  echo "updated ${group_file}: .env identities plus ${granted} portal grant(s)"
}

case "${mode}" in
  once)
    sync_once
    ;;
  loop)
    echo "syncing Trino groups every ${interval}s"
    while true; do
      sync_once || true
      sleep "${interval}"
    done
    ;;
  *)
    echo "usage: sync-trino-groups.sh once|loop" >&2
    exit 1
    ;;
esac
