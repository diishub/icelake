#!/bin/sh
set -eu

expected_group_file="$(mktemp)"
trap 'rm -f "${expected_group_file}"' EXIT

{
  printf 'psu_admin:%s\n' "${PSU_ADMIN_USERNAME}"
  printf 'psu_ingestion:%s\n' "${TRINO_INGESTION_USERNAME}"
  printf 'psu_analyst:%s,superset\n' "${PSU_ANALYST_USERNAME}"
  printf 'psu_viewer:%s\n' "${PSU_VIEWER_USERNAME}"
} >"${expected_group_file}"

expected_hash="$(sha256sum "${expected_group_file}" | awk '{print $1}')"
actual_hash="$(sha256sum /var/trino/data/groups.txt | awk '{print $1}')"
if [ "${expected_hash}" != "${actual_hash}" ]; then
  echo "Trino dev group mapping does not match the current Compose environment" >&2
  exit 1
fi

echo "PASS Trino dev group mapping matches all configured identities"
