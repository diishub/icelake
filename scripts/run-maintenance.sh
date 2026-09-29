#!/bin/sh
# Iceberg table maintenance, driven by the registry.
#
# Compaction keeps queries fast as tables grow. Snapshot expiry and
# orphan-file removal do something else: they are what actually deletes data.
# Dropping a table in this stack leaves its files in object storage, so a
# deletion request is not satisfied until removal has run over that location.
#
# Runs as the maintenance Trino identity, which can reshape and expire files
# but is not allowed to read a single row (see config/opa/trino.rego).
#
# Usage:
#   ./scripts/run-maintenance.sh                       optimize + expire snapshots
#   ./scripts/run-maintenance.sh --include-orphans     also remove orphaned files
#   ./scripts/run-maintenance.sh --dry-run             print the statements only
#   ./scripts/run-maintenance.sh --min-retention 0s    allow thresholds under
#                                                      the 7-day floor (testing)
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

include_orphans=false
dry_run=false
min_retention=""

while [ $# -gt 0 ]; do
  case "$1" in
    --include-orphans) include_orphans=true ;;
    --dry-run)         dry_run=true ;;
    --min-retention)   shift; min_retention="${1:-}" ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

maintenance_user="$(grep '^TRINO_MAINTENANCE_USERNAME=' .env | cut -d= -f2- || true)"
maintenance_user="${maintenance_user:-maintenance}"
maintenance_password="$(trino_password_for TRINO_MAINTENANCE_PASSWORD)"

psql_platform() {
  docker compose exec -T postgres /bin/sh -ec \
    'PGPASSWORD="${POSTGRES_PASSWORD}" psql --host 127.0.0.1 --username "${POSTGRES_USER}" \
       --dbname platform --no-align --tuples-only --quiet --no-psqlrc --field-separator="|" -f -'
}

session_flags=""
if [ -n "${min_retention}" ]; then
  # The 7-day floor exists so a mistyped threshold cannot delete files a
  # running query still needs. Lowering it is for testing on synthetic data.
  echo "WARNING: lowering the retention floor to ${min_retention}; only do this on synthetic data"
  session_flags="--session polaris.expire_snapshots_min_retention=${min_retention} --session polaris.remove_orphan_files_min_retention=${min_retention}"
fi

trino_execute() {
  trino_sql "${maintenance_user}" "${maintenance_password}" "$1" ${session_flags}
}

record() {
  printf "INSERT INTO ingest.maintenance_run (target_table, action, status, retention_applied, detail, ended_at) VALUES ('%s', '%s', '%s', %s, %s, now());\n" \
    "$1" "$2" "$3" "$4" "$5" | psql_platform >/dev/null
}

target_list="$(mktemp)"
trap 'rm -f "${target_list}"' EXIT
targets="$(psql_platform < scripts/sql/maintenance-targets.sql)"
if [ -z "${targets}" ]; then
  echo "no enabled tables are registered; nothing to maintain"
  exit 0
fi

# The loop body runs docker commands, which would otherwise consume the
# loop input from standard input; feed it from a file descriptor instead.
printf "%s\n" "${targets}" > "${target_list}"
while IFS="|" read -r target_table target_schema target_name optimize_enabled expire_days orphan_days <&3; do
  [ -n "${target_table}" ] || continue
  qualified="polaris.${target_schema}.\"${target_name}\""

  if [ "${optimize_enabled}" = "t" ]; then
    statement="ALTER TABLE ${qualified} EXECUTE optimize"
    if [ "${dry_run}" = true ]; then
      echo "DRY RUN ${statement}"
    else
      if output="$(trino_execute "${statement}")"; then
        echo "optimize            ${target_table}"
        record "${target_table}" "optimize" "succeeded" "NULL" "NULL"
      else
        echo "optimize FAILED     ${target_table}: ${output}" >&2
        record "${target_table}" "optimize" "failed" "NULL" "'$(printf '%s' "${output}" | tr "'" ' ' | head -c 200)'"
      fi
    fi
  fi

  retention="${min_retention:-${expire_days}d}"
  statement="ALTER TABLE ${qualified} EXECUTE expire_snapshots(retention_threshold => '${retention}')"
  if [ "${dry_run}" = true ]; then
    echo "DRY RUN ${statement}"
  else
    if output="$(trino_execute "${statement}")"; then
      echo "expire_snapshots    ${target_table} (${retention})"
      record "${target_table}" "expire_snapshots" "succeeded" "'${retention}'" "NULL"
    else
      echo "expire_snapshots FAILED ${target_table}: ${output}" >&2
      record "${target_table}" "expire_snapshots" "failed" "'${retention}'" "'$(printf '%s' "${output}" | tr "'" ' ' | head -c 200)'"
    fi
  fi

  if [ "${include_orphans}" = true ]; then
    retention="${min_retention:-${orphan_days}d}"
    statement="ALTER TABLE ${qualified} EXECUTE remove_orphan_files(retention_threshold => '${retention}')"
    if [ "${dry_run}" = true ]; then
      echo "DRY RUN ${statement}"
    else
      if output="$(trino_execute "${statement}")"; then
        echo "remove_orphan_files ${target_table} (${retention})"
        record "${target_table}" "remove_orphan_files" "succeeded" "'${retention}'" "NULL"
      else
        echo "remove_orphan_files FAILED ${target_table}: ${output}" >&2
        record "${target_table}" "remove_orphan_files" "failed" "'${retention}'" "'$(printf '%s' "${output}" | tr "'" ' ' | head -c 200)'"
      fi
    fi
  fi
done 3< "${target_list}"

if [ "${include_orphans}" != true ] && [ "${dry_run}" != true ]; then
  echo
  echo "Orphaned files were left in place. They are what remains after a table"
  echo "is dropped, so removing personal data on request needs:"
  echo "  ./scripts/run-maintenance.sh --include-orphans"
fi
