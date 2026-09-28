#!/bin/sh
# Turns a staged steward upload (config/platform/016-upload-log.sql,
# identity.upload_event) into a queryable Iceberg table, or records that it
# was declined -- the manual review step README section 6.13 describes:
# an uploaded file has had no column-classification/lawful-basis review, so
# nothing in it reaches Trino/Superset until a human decides which columns
# are safe.
#
# Before running this: open the object in the RustFS Console
# (http://localhost:9001, README section 6.5) to see its header and a few
# rows, then write a review file describing every column.
#
# Approve:
#   scripts/review-upload.sh <upload_id> <review.json>
#
# review.json:
#   {
#     "reviewer": "your-name-or-username",
#     "table_suffix": "system_activity",
#     "columns": [
#       {"name": "event_time", "type": "TIMESTAMP", "classification": "public"},
#       {"name": "user_email", "type": "VARCHAR",   "classification": "sensitive"}
#     ]
#   }
# Every column in the CSV header must be listed, in order -- the staging
# pointer table needs the full shape to parse the file at all. Only
# "public" columns are ever selected into the target table; type is one of
# VARCHAR, BIGINT, INTEGER, DOUBLE, BOOLEAN, DATE, TIMESTAMP (declared, never
# inferred -- the same rule config/nifi/scripts/dotblue_tables.json follows).
# The target table is polaris.raw.steward_<org_unit>_<table_suffix>.
#
# A .pdf/.docx upload has no columns to classify -- approve it instead with:
#   scripts/review-upload.sh <upload_id> --approve-document --reviewer <name>
# This only records the review decision (identity.upload_event.status
# becomes 'registered', target_table stays null); it does not create
# anything in Trino. Read the extracted plain text first at
# <the object's own key>.extracted.txt in RustFS Console, next to the
# original file -- or the original file itself if extraction failed
# (identity.upload_event.extracted_text_key is null in that case).
#
# Reject (csv, pdf, or docx alike):
#   scripts/review-upload.sh <upload_id> --reject "<reason>" --reviewer <name>
#
# Runs the Trino side as the existing ingestion identity
# (TRINO_INGESTION_USERNAME/_PASSWORD) -- already granted exactly
# polaris.raw + hive.raw_staging in config/opa/trino.rego, the same as every
# other file-based load. No new Trino identity, no new OPA rule.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

# Not exported globally: MSYS_NO_PATHCONV stops Git Bash rewriting a
# container-internal path like /bin/sh for `docker compose exec`, which the
# calls below need, but the native `node` call further down needs the
# opposite -- Git Bash's own path translation is what turns a review.json
# path into something node.exe can open at all. Each docker call gets it
# locally instead (scripts/lib/trino.sh's own trino_sql already does the
# same, scoped to just its one call).

. ./scripts/lib/trino.sh

usage() {
  cat >&2 <<'USAGE'
usage:
  review-upload.sh <upload_id> <review.json>
  review-upload.sh <upload_id> --approve-document --reviewer <name>
  review-upload.sh <upload_id> --reject "<reason>" --reviewer <name>
USAGE
}

upload_id="${1:-}"
if [ -z "${upload_id}" ]; then
  usage
  exit 1
fi
shift

reject_reason=""
approve_document=""
reviewer=""
review_file=""
if [ "${1:-}" = "--reject" ]; then
  reject_reason="${2:-}"
  if [ "${3:-}" != "--reviewer" ] || [ -z "${4:-}" ]; then
    echo "reject needs: --reject \"<reason>\" --reviewer <name>" >&2
    exit 1
  fi
  reviewer="$4"
  if [ -z "${reject_reason}" ]; then
    echo "a reject reason is required" >&2
    exit 1
  fi
elif [ "${1:-}" = "--approve-document" ]; then
  approve_document=1
  if [ "${2:-}" != "--reviewer" ] || [ -z "${3:-}" ]; then
    echo "approve-document needs: --approve-document --reviewer <name>" >&2
    exit 1
  fi
  reviewer="$3"
else
  review_file="${1:-}"
  if [ -z "${review_file}" ] || [ ! -f "${review_file}" ]; then
    usage
    exit 1
  fi
fi

if [ ! -f .env ]; then
  echo "no .env in ${repo_dir}" >&2
  exit 1
fi

postgres_user="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"
postgres_password="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
if [ -z "${postgres_user}" ] || [ -z "${postgres_password}" ]; then
  echo "POSTGRES_USER / POSTGRES_PASSWORD must be set in .env" >&2
  exit 1
fi

# One pipe-separated row: status|org_unit|object_key|psu_username|file_kind.
# psql variable substitution (:'upload_id') does its own quoting, same
# pattern as scripts/create-password-account.sh.
lookup="$(MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="$0" psql --host 127.0.0.1 --username "$1" --dbname platform --quiet --no-psqlrc --no-align --tuples-only \
     --set upload_id="$2" -f -' \
  "${postgres_password}" "${postgres_user}" "${upload_id}" <<'SQL'
SELECT e.status || '|' || e.org_unit || '|' || e.object_key || '|' || COALESCE(u.psu_username, '') || '|' || e.file_kind
  FROM identity.upload_event e JOIN identity.app_user u ON u.user_id = e.user_id
 WHERE e.upload_id = :'upload_id';
SQL
)"

if [ -z "${lookup}" ]; then
  echo "no upload_event row for ${upload_id}" >&2
  exit 1
fi

status="$(printf '%s' "${lookup}" | cut -d'|' -f1)"
org_unit="$(printf '%s' "${lookup}" | cut -d'|' -f2)"
object_key="$(printf '%s' "${lookup}" | cut -d'|' -f3)"
uploaded_by="$(printf '%s' "${lookup}" | cut -d'|' -f4)"
file_kind="$(printf '%s' "${lookup}" | cut -d'|' -f5)"

if [ "${status}" != "pending_review" ]; then
  echo "upload ${upload_id} is already '${status}', not pending_review -- refusing to review it again" >&2
  exit 1
fi

if [ -n "${review_file}" ] && [ "${file_kind}" != "csv" ]; then
  echo "upload ${upload_id} is a .${file_kind}, which has no columns -- use --approve-document instead of a review.json" >&2
  exit 1
fi
if [ -n "${approve_document}" ] && [ "${file_kind}" = "csv" ]; then
  echo "upload ${upload_id} is a .csv -- use a review.json to classify its columns, not --approve-document" >&2
  exit 1
fi

if [ -n "${approve_document}" ]; then
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    'PGPASSWORD="$0" psql --host 127.0.0.1 --username "$1" --dbname platform --quiet --no-psqlrc \
       --set upload_id="$2" --set reviewer="$3" -f -' \
    "${postgres_password}" "${postgres_user}" "${upload_id}" "${reviewer}" <<'SQL' >/dev/null
UPDATE identity.upload_event
   SET status = 'registered', reviewed_by_username = :'reviewer', reviewed_at = now()
 WHERE upload_id = :'upload_id';
SQL
  echo "approved ${upload_id} (.${file_kind}) -- reviewed by ${reviewer}, nothing created in Trino"
  exit 0
fi

if [ -n "${reject_reason}" ]; then
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
    'PGPASSWORD="$0" psql --host 127.0.0.1 --username "$1" --dbname platform --quiet --no-psqlrc \
       --set upload_id="$2" --set reviewer="$3" -f -' \
    "${postgres_password}" "${postgres_user}" "${upload_id}" "${reviewer}" <<'SQL' >/dev/null
UPDATE identity.upload_event
   SET status = 'rejected', reviewed_by_username = :'reviewer', reviewed_at = now()
 WHERE upload_id = :'upload_id';
SQL
  echo "rejected ${upload_id}: ${reject_reason}"
  exit 0
fi

parsed="$(node ./scripts/lib/parse-upload-review.mjs "${review_file}" "${org_unit}")"
target_table="$(printf '%s\n' "${parsed}" | sed -n '1p')"
staging_columns_sql="$(printf '%s\n' "${parsed}" | sed -n '2p')"
target_columns_sql="$(printf '%s\n' "${parsed}" | sed -n '3p')"
insert_columns_sql="$(printf '%s\n' "${parsed}" | sed -n '4p')"
select_list_sql="$(printf '%s\n' "${parsed}" | sed -n '5p')"
columns_included="$(printf '%s\n' "${parsed}" | sed -n '6p')"
columns_excluded="$(printf '%s\n' "${parsed}" | sed -n '7p')"
reviewer="$(printf '%s\n' "${parsed}" | sed -n '8p')"

trino_user="$(grep '^TRINO_INGESTION_USERNAME=' .env | cut -d= -f2-)"
trino_password="$(trino_password_for TRINO_INGESTION_PASSWORD)"
bucket="$(grep '^RUSTFS_BUCKET=' .env | cut -d= -f2-)"
bucket="${bucket:-psu-lakehouse}"

staging_dir="$(dirname -- "${object_key}")/"
staging_table="stg_$(printf '%s' "${upload_id}" | tr -d '-')"
qualified_target="polaris.raw.\"${target_table}\""
qualified_staging="hive.raw_staging.\"${staging_table}\""

cleanup_staging() {
  trino_sql "${trino_user}" "${trino_password}" "DROP TABLE IF EXISTS ${qualified_staging}" >/dev/null 2>&1 || true
}
trap cleanup_staging EXIT

echo "creating ${qualified_target} if it does not already exist..." >&2
if ! output="$(trino_sql "${trino_user}" "${trino_password}" \
  "CREATE TABLE IF NOT EXISTS ${qualified_target} (${target_columns_sql}, \"_ingested_at\" TIMESTAMP(6), \"_source_system\" VARCHAR, \"_uploaded_by\" VARCHAR, \"_org_unit\" VARCHAR, \"_run_id\" VARCHAR) WITH (partitioning = ARRAY['day(_ingested_at)'])")"; then
  echo "${output}" >&2
  echo "could not create ${qualified_target} -- upload_event left at pending_review" >&2
  exit 1
fi

echo "pointing a staging table at the uploaded file..." >&2
if ! output="$(trino_sql "${trino_user}" "${trino_password}" \
  "CREATE TABLE ${qualified_staging} (${staging_columns_sql}) WITH (external_location = 's3://${bucket}/${staging_dir}', format = 'CSV', skip_header_line_count = 1)")"; then
  echo "${output}" >&2
  echo "could not create the staging pointer -- upload_event left at pending_review" >&2
  exit 1
fi

echo "loading the public column(s) into ${qualified_target}..." >&2
if ! output="$(trino_sql "${trino_user}" "${trino_password}" \
  "INSERT INTO ${qualified_target} (${insert_columns_sql}, \"_ingested_at\", \"_source_system\", \"_uploaded_by\", \"_org_unit\", \"_run_id\")
   SELECT ${select_list_sql}, now(), 'manual-upload', '${uploaded_by}', '${org_unit}', '${upload_id}'
     FROM ${qualified_staging}")"; then
  echo "${output}" >&2
  echo "load failed -- upload_event left at pending_review, fix review.json and rerun" >&2
  exit 1
fi

MSYS_NO_PATHCONV=1 docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="$0" psql --host 127.0.0.1 --username "$1" --dbname platform --quiet --no-psqlrc \
     --set upload_id="$2" --set reviewer="$3" --set target_table="$4" \
     --set columns_included="$5" --set columns_excluded="$6" -f -' \
  "${postgres_password}" "${postgres_user}" "${upload_id}" "${reviewer}" "raw.${target_table}" \
  "${columns_included}" "${columns_excluded}" <<'SQL' >/dev/null
UPDATE identity.upload_event
   SET status = 'registered', target_table = :'target_table',
       reviewed_by_username = :'reviewer', reviewed_at = now(),
       columns_included = :'columns_included', columns_excluded = :'columns_excluded'
 WHERE upload_id = :'upload_id';
SQL

echo "registered ${upload_id} as polaris.raw.${target_table} (${columns_included} column(s) included, ${columns_excluded} excluded)"
