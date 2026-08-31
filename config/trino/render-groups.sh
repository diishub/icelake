#!/bin/sh
set -eu

validate_username() {
  variable_name="$1"
  username="$2"
  case "${username}" in
    ""|*[!A-Za-z0-9._-]*)
      echo "${variable_name} must contain only letters, numbers, dot, underscore, or hyphen" >&2
      exit 1
      ;;
  esac
}

validate_org_unit() {
  variable_name="$1"
  org_unit="$2"
  case "${org_unit}" in
    "*") ;;
    ""|*[!a-z0-9_-]*)
      echo "${variable_name} must be '*' or contain only lowercase letters, numbers, underscore, or hyphen" >&2
      exit 1
      ;;
  esac
}

case "${PSU_VIEWER_COUNT}" in
  ''|*[!0-9]*)
    echo "PSU_VIEWER_COUNT must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "${PSU_VIEWER_COUNT}" -lt 1 ]; then
  echo "PSU_VIEWER_COUNT must be a positive integer" >&2
  exit 1
fi

validate_username PSU_ADMIN_USERNAME "${PSU_ADMIN_USERNAME}"
validate_username PSU_ANALYST_USERNAME "${PSU_ANALYST_USERNAME}"
validate_username TRINO_INGESTION_USERNAME "${TRINO_INGESTION_USERNAME}"

all_usernames="${PSU_ADMIN_USERNAME} ${PSU_ANALYST_USERNAME} ${TRINO_INGESTION_USERNAME}"

viewer_index=1
viewer_usernames=""
exec_usernames=""
org_units=""
while [ "${viewer_index}" -le "${PSU_VIEWER_COUNT}" ]; do
  eval "viewer_username=\${PSU_VIEWER_${viewer_index}_USERNAME:-}"
  eval "viewer_org_unit=\${PSU_VIEWER_${viewer_index}_ORG_UNIT:-}"

  validate_username "PSU_VIEWER_${viewer_index}_USERNAME" "${viewer_username}"
  validate_org_unit "PSU_VIEWER_${viewer_index}_ORG_UNIT" "${viewer_org_unit}"

  for existing in ${all_usernames}; do
    if [ "${existing}" = "${viewer_username}" ]; then
      echo "Trino dev identities must be distinct (duplicate: ${viewer_username})" >&2
      exit 1
    fi
  done

  all_usernames="${all_usernames} ${viewer_username}"
  viewer_usernames="${viewer_usernames:+${viewer_usernames},}${viewer_username}"

  if [ "${viewer_org_unit}" = "*" ]; then
    exec_usernames="${exec_usernames:+${exec_usernames},}${viewer_username}"
  else
    # Org units may contain '-', which isn't valid in a shell variable name;
    # use an underscore-safe key for the eval'd accumulator variable while
    # keeping the real org-unit string (with '-') for output and the list.
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

for name in ${all_usernames}; do
  if [ "${name}" = "superset" ]; then
    echo "Trino dev identities must not use the reserved Superset connection name" >&2
    exit 1
  fi
done

umask 022
group_file_tmp="/output/groups.txt.tmp"
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
} >"${group_file_tmp}"
mv "${group_file_tmp}" /output/groups.txt

echo "Rendered Trino dev group mapping without credentials"
