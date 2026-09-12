#!/bin/sh
# Publish the dotBlue aggregate tables to polaris.published.
#
# The dashboard reads published, never raw. That is not decoration: OPA lets a
# report viewer select from published only, so anything a viewer is meant to
# see has to be exposed here, and anything exposed here is visible to every
# viewer. Each view is a plain projection of its raw table with the four audit
# columns dropped -- they belong to the pipeline, not to the report.
#
# Views rather than CTAS copies, so a re-ingest is visible immediately and
# there is only ever one copy of the data on disk.
#
# DDL, so this runs as the admin identity: OPA grants analysts INSERT/UPDATE/
# DELETE on published but not DDL.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

admin_user="$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)"
admin_password="$(trino_password_for PSU_ADMIN_PASSWORD)"

# table:column list. Kept explicit rather than SELECT * so a new column added
# upstream does not reach a report without someone deciding that it should.
views="
dotblue_collection_profile:collection, doc_count, data_mb
dotblue_conv_by_hour:hour_th, conversations, unique_users
dotblue_conv_by_month:month, conversations, unique_users, messages
dotblue_conv_by_dow:dow_num, dow_th, conversations
dotblue_conv_by_endpoint:endpoint, spec, conversations
dotblue_user_by_group:user_group, users, conversations
dotblue_conv_by_group_month:month, user_group, conversations, unique_users
dotblue_user_cohort:signup_month, new_users
dotblue_user_mix:dimension, value, users
"

failures=0

echo "${views}" | while IFS= read -r entry; do
  [ -n "${entry}" ] || continue
  table="${entry%%:*}"
  columns="${entry#*:}"
  sql="CREATE OR REPLACE VIEW polaris.published.\"v_${table}\" AS
       SELECT ${columns} FROM polaris.raw.\"${table}\""
  if trino_sql "${admin_user}" "${admin_password}" "${sql}" --output-format TSV >/dev/null; then
    echo "PASS published v_${table}"
  else
    echo "FAIL could not publish v_${table}" >&2
    failures=$((failures + 1))
  fi
done

# Freshness is a property of the load, not of any one report, so it gets its
# own view instead of a column on all nine.
trino_sql "${admin_user}" "${admin_password}" \
  "CREATE OR REPLACE VIEW polaris.published.\"v_dotblue_freshness\" AS
   SELECT _source_table AS table_name,
          max(_ingested_at) AS last_ingested_at,
          max(_run_id) AS last_run_id
   FROM polaris.raw.dotblue_collection_profile GROUP BY _source_table" \
  --output-format TSV >/dev/null && echo "PASS published v_dotblue_freshness"

exit "${failures}"
