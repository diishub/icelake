#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

if [ ! -f .env ]; then
  echo "Missing .env; copy .env.example and replace every placeholder first" >&2
  exit 1
fi

env_mode="$(stat -f '%Lp' .env 2>/dev/null || stat -c '%a' .env)"
if [ "${env_mode}" != "600" ]; then
  echo ".env permissions must be 600; run chmod 600 .env" >&2
  exit 1
fi

required_variables="
POSTGRES_USER
POSTGRES_PASSWORD
RUSTFS_ACCESS_KEY
RUSTFS_SECRET_KEY
RUSTFS_BUCKET
POLARIS_REALM
POLARIS_CLIENT_ID
POLARIS_CLIENT_SECRET
POLARIS_CATALOG
TRINO_INGESTION_USERNAME
PSU_ADMIN_USERNAME
PSU_ADMIN_PASSWORD
PSU_ANALYST_USERNAME
PSU_ANALYST_PASSWORD
PSU_VIEWER_USERNAME
PSU_VIEWER_PASSWORD
SUPERSET_SECRET_KEY
QDRANT_API_KEY
NIFI_USERNAME
NIFI_PASSWORD
"

for variable_name in ${required_variables}; do
  matching_lines="$(awk -v key="${variable_name}" 'index($0, key "=") == 1 {count++} END {print count + 0}' .env)"
  if [ "${matching_lines}" -ne 1 ]; then
    echo ".env must define ${variable_name} exactly once" >&2
    exit 1
  fi

  variable_value="$(awk -v key="${variable_name}" 'index($0, key "=") == 1 {sub("^[^=]*=", ""); print}' .env)"
  normalized_value="${variable_value}"
  case "${normalized_value}" in
    \"*\") normalized_value="${normalized_value#\"}"; normalized_value="${normalized_value%\"}" ;;
    \'*\') normalized_value="${normalized_value#\'}"; normalized_value="${normalized_value%\'}" ;;
  esac
  case "${normalized_value}" in
    ""|change-me*)
      echo "Replace the empty or placeholder value for ${variable_name} in .env" >&2
      exit 1
      ;;
  esac
done

docker compose config --quiet
echo "PASS .env contains every required non-placeholder development setting"
