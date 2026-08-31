#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

if [ ! -f .env ]; then
  echo "Missing .env; copy .env.example and replace every placeholder first" >&2
  exit 1
fi

# Try GNU stat (Linux) first, then BSD/macOS stat -- as two separate
# command substitutions, not one, so a failing GNU attempt can't leak its
# partial stdout (stat -f on GNU treats '%Lp' as a second file operand and
# prints a filesystem-info dump for the real file before failing on it).
env_mode="$(stat -c '%a' .env 2>/dev/null)" || env_mode="$(stat -f '%Lp' .env 2>/dev/null)"
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
PSU_VIEWER_COUNT
SUPERSET_SECRET_KEY
QDRANT_API_KEY
NIFI_USERNAME
NIFI_PASSWORD
"

viewer_count_value="$(awk -v key="PSU_VIEWER_COUNT" 'index($0, key "=") == 1 {sub("^[^=]*=", ""); print}' .env)"
case "${viewer_count_value}" in
  ''|*[!0-9]*)
    echo "PSU_VIEWER_COUNT in .env must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "${viewer_count_value}" -lt 1 ]; then
  echo "PSU_VIEWER_COUNT in .env must be a positive integer" >&2
  exit 1
fi

viewer_index=1
while [ "${viewer_index}" -le "${viewer_count_value}" ]; do
  required_variables="${required_variables}
PSU_VIEWER_${viewer_index}_USERNAME
PSU_VIEWER_${viewer_index}_PASSWORD
PSU_VIEWER_${viewer_index}_ORG_UNIT"
  viewer_index=$((viewer_index + 1))
done

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

  case "${variable_name}" in
    *_ORG_UNIT)
      case "${normalized_value}" in
        "*") ;;
        *[!a-z0-9_-]*)
          echo "${variable_name} must be '*' or contain only lowercase letters, numbers, underscore, or hyphen" >&2
          exit 1
          ;;
      esac
      ;;
  esac
done

docker compose config --quiet
echo "PASS .env contains every required non-placeholder development setting"
