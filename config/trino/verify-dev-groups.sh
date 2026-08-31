#!/bin/sh
set -eu

expected_group_file="$(mktemp)"
trap 'rm -f "${expected_group_file}"' EXIT

# Independently reconstructs the group file that render-groups.sh should have
# produced from the same environment, then hash-compares against the actual
# rendered file. Kept as separate logic from render-groups.sh on purpose (an
# independent check), so any change there must be mirrored here too.
viewer_index=1
viewer_usernames=""
exec_usernames=""
org_units=""
while [ "${viewer_index}" -le "${PSU_VIEWER_COUNT}" ]; do
  eval "viewer_username=\${PSU_VIEWER_${viewer_index}_USERNAME}"
  eval "viewer_org_unit=\${PSU_VIEWER_${viewer_index}_ORG_UNIT}"

  viewer_usernames="${viewer_usernames:+${viewer_usernames},}${viewer_username}"

  if [ "${viewer_org_unit}" = "*" ]; then
    exec_usernames="${exec_usernames:+${exec_usernames},}${viewer_username}"
  else
    safe_key="$(printf '%s' "${viewer_org_unit}" | tr '-' '_')"
    eval "org_unit_users_${safe_key}=\"\${org_unit_users_${safe_key}:-}\${org_unit_users_${safe_key}:+,}${viewer_username}\""
    already_listed=0
    for existing_unit in ${org_units}; do
      [ "${existing_unit}" = "${viewer_org_unit}" ] && already_listed=1
    done
    [ "${already_listed}" -eq 0 ] && org_units="${org_units} ${viewer_org_unit}"
  fi

  viewer_index=$((viewer_index + 1))
done

{
  printf 'psu_admin:%s\n' "${PSU_ADMIN_USERNAME}"
  printf 'psu_ingestion:%s\n' "${TRINO_INGESTION_USERNAME}"
  printf 'psu_analyst:%s,superset\n' "${PSU_ANALYST_USERNAME}"
  printf 'psu_viewer:%s\n' "${viewer_usernames}"
  if [ -n "${exec_usernames}" ]; then
    printf 'psu_viewer_exec:%s\n' "${exec_usernames}"
  fi
  for org_unit in ${org_units}; do
    safe_key="$(printf '%s' "${org_unit}" | tr '-' '_')"
    eval "members=\${org_unit_users_${safe_key}}"
    printf 'psu_viewer_org_%s:%s\n' "${org_unit}" "${members}"
  done
} >"${expected_group_file}"

expected_hash="$(sha256sum "${expected_group_file}" | awk '{print $1}')"
actual_hash="$(sha256sum /var/trino/data/groups.txt | awk '{print $1}')"
if [ "${expected_hash}" != "${actual_hash}" ]; then
  echo "Trino dev group mapping does not match the current Compose environment" >&2
  exit 1
fi

echo "PASS Trino dev group mapping matches all configured identities"
