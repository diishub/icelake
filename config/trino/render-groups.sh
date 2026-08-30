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

validate_username PSU_ADMIN_USERNAME "${PSU_ADMIN_USERNAME}"
validate_username PSU_ANALYST_USERNAME "${PSU_ANALYST_USERNAME}"
validate_username PSU_VIEWER_USERNAME "${PSU_VIEWER_USERNAME}"
validate_username TRINO_INGESTION_USERNAME "${TRINO_INGESTION_USERNAME}"

if [ "${PSU_ADMIN_USERNAME}" = "superset" ] || \
   [ "${PSU_ANALYST_USERNAME}" = "superset" ] || \
   [ "${PSU_VIEWER_USERNAME}" = "superset" ] || \
   [ "${TRINO_INGESTION_USERNAME}" = "superset" ]; then
  echo "Trino dev identities must not use the reserved Superset connection name" >&2
  exit 1
fi

if [ "${PSU_ADMIN_USERNAME}" = "${PSU_ANALYST_USERNAME}" ] || \
   [ "${PSU_ADMIN_USERNAME}" = "${PSU_VIEWER_USERNAME}" ] || \
   [ "${PSU_ADMIN_USERNAME}" = "${TRINO_INGESTION_USERNAME}" ] || \
   [ "${PSU_ANALYST_USERNAME}" = "${PSU_VIEWER_USERNAME}" ] || \
   [ "${PSU_ANALYST_USERNAME}" = "${TRINO_INGESTION_USERNAME}" ] || \
   [ "${PSU_VIEWER_USERNAME}" = "${TRINO_INGESTION_USERNAME}" ]; then
  echo "Trino dev identities must be distinct" >&2
  exit 1
fi

umask 022
group_file_tmp="/output/groups.txt.tmp"
{
  printf 'psu_admin:%s\n' "${PSU_ADMIN_USERNAME}"
  printf 'psu_ingestion:%s\n' "${TRINO_INGESTION_USERNAME}"
  printf 'psu_analyst:%s,superset\n' "${PSU_ANALYST_USERNAME}"
  printf 'psu_viewer:%s\n' "${PSU_VIEWER_USERNAME}"
} >"${group_file_tmp}"
mv "${group_file_tmp}" /output/groups.txt

echo "Rendered Trino dev group mapping without credentials"
