#!/bin/sh
# Prove what the dotBlue ingestion actually produced.
#
# The cases that matter are the negative ones. These extracts come from a
# production LibreChat database holding real personal data, and the whole
# design rests on the claim that nothing identifying a person was carried into
# the lakehouse. That claim is worth a test, not a comment: no column may name
# a user, an e-mail address, a conversation title, a message body or a
# credential, and no published group may fall below the k-anonymity threshold.
#
# Run after the NiFi flow has picked up data/incoming/csv and after
# ./scripts/publish-dotblue-views.sh.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

admin_user="$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)"
admin_password="$(trino_password_for PSU_ADMIN_PASSWORD)"
viewer_user="$(grep '^PSU_VIEWER_1_USERNAME=' .env | cut -d= -f2)"
viewer_password="$(trino_password_for PSU_VIEWER_1_PASSWORD)"
failures=0

trino_query() {
  trino_sql "${admin_user}" "${admin_password}" "$1" --output-format TSV | tr -d '"'
}

check() {
  case_name="$1"; expected="$2"; actual="$3"
  if [ "${actual}" = "${expected}" ]; then
    echo "PASS ${case_name}"
  else
    failures=$((failures + 1))
    echo "FAIL ${case_name}: expected '${expected}', got '${actual}'" >&2
  fi
}

# ---------------------------------------------------------------------------
# The negative cases: what must NOT have reached the lakehouse.
# ---------------------------------------------------------------------------

# LibreChat's own column names. If ingestion ever widens from aggregates to
# raw documents, this is the test that fails first.
#
# The second clause is the subtle one. A column called "messages" is fine when
# it holds a count and catastrophic when it holds the text, and the name alone
# cannot tell the two apart -- so the content-shaped names are allowed through
# only while they stay numeric. Naming them here without the type check would
# have failed on the message COUNT this dashboard is built around, and the
# obvious fix for that failure is to delete the check, which is how a real
# leak gets waved through later.
check "no personal or credential column reached any dotblue table" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.columns
      WHERE table_schema IN ('raw','published') AND table_name LIKE '%dotblue%'
        AND (column_name IN ('user','userid','user_id','email','username','name',
                             'password','refreshtoken','backupcodes','apikey',
                             'openidid','idonthesource','conversationid','_id')
             OR (column_name IN ('title','text','content','message','messages',
                                 'body','prompt','response')
                 AND data_type NOT IN ('bigint','integer','smallint','double',
                                       'real','decimal')))")"

# The suppression rule is what makes a group chart safe to publish at all.
check "no published group falls below k=10 users" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.published.v_dotblue_user_by_group WHERE users < 10")"

check "no published group/month cell falls below k=10 users" "0" \
  "$(trino_query "SELECT count(*) FROM polaris.published.v_dotblue_conv_by_group_month WHERE unique_users < 10")"

# A report viewer reads published and nothing else. Raw carries the audit
# columns and is the pipeline's working area, not a report surface.
check "a viewer can read the published dashboard data" "3" \
  "$(trino_sql "${viewer_user}" "${viewer_password}" \
      "SELECT count(*) FROM polaris.published.v_dotblue_user_by_group" \
      --output-format TSV | tr -d '"')"

check "a viewer is refused on raw" "denied" \
  "$(trino_sql "${viewer_user}" "${viewer_password}" \
      "SELECT count(*) FROM polaris.raw.dotblue_user_by_group" --output-format TSV \
      | grep -qi 'access denied' && echo denied || echo allowed)"

# ---------------------------------------------------------------------------
# The positive cases: the aggregates did arrive, so the filter is not simply
# dropping everything.
# ---------------------------------------------------------------------------

check "all nine aggregate tables exist" "9" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.tables
      WHERE table_schema = 'raw' AND table_name LIKE 'dotblue_%'")"

check "all ten published views exist" "10" \
  "$(trino_query "SELECT count(*) FROM polaris.information_schema.tables
      WHERE table_schema = 'published' AND table_name LIKE 'v_dotblue%'")"

check "every dotblue table carries the four audit columns" "0" \
  "$(trino_query "SELECT count(*) FROM (
        SELECT table_name FROM polaris.information_schema.columns
        WHERE table_schema = 'raw' AND table_name LIKE 'dotblue_%'
          AND column_name IN ('_ingested_at','_source_system','_source_table','_run_id')
        GROUP BY table_name HAVING count(*) <> 4)")"

# Row counts are fixed by the shape of the source: 35 collections, 24 hours,
# 7 days. A change here means the extract changed, which should be deliberate.
check "row counts match the extract" "35 24 7" \
  "$(trino_query "SELECT concat_ws(' ',
      CAST((SELECT count(*) FROM polaris.raw.dotblue_collection_profile) AS varchar),
      CAST((SELECT count(*) FROM polaris.raw.dotblue_conv_by_hour) AS varchar),
      CAST((SELECT count(*) FROM polaris.raw.dotblue_conv_by_dow) AS varchar))")"

# The totals are the ones the source archive reports, so a silently truncated
# load is visible rather than merely smaller.
check "conversation and message totals match the source archive" "60580 659737" \
  "$(trino_query "SELECT concat_ws(' ',
      CAST((SELECT CAST(sum(conversations) AS bigint) FROM polaris.published.v_dotblue_conv_by_month) AS varchar),
      CAST((SELECT CAST(sum(messages) AS bigint) FROM polaris.published.v_dotblue_conv_by_month) AS varchar))")"

# ---------------------------------------------------------------------------
# The dashboard itself.
# ---------------------------------------------------------------------------

superset_python() {
  docker compose exec -T superset python -c "$1" 2>/dev/null | tail -1
}

check "the dashboard exists with its twelve charts" "12" \
  "$(superset_python "
from superset.app import create_app
app = create_app()
with app.app_context():
    from superset import db
    from superset.models.dashboard import Dashboard
    d = db.session.query(Dashboard).filter_by(slug='dotblue-usage').one_or_none()
    print(len(d.slices) if d else 'missing')
")"

# Without a saved query context the charts draw in a browser but every
# headless caller fails, which is exactly the kind of breakage nobody notices.
check "every chart has a saved query context" "0" \
  "$(superset_python "
from superset.app import create_app
app = create_app()
with app.app_context():
    from superset import db
    from superset.models.dashboard import Dashboard
    d = db.session.query(Dashboard).filter_by(slug='dotblue-usage').one_or_none()
    print(sum(1 for s in d.slices if not s.query_context) if d else 'missing')
")"

if [ "${failures}" -eq 0 ]; then
  echo "all dotBlue dashboard checks passed"
else
  echo "${failures} check(s) failed" >&2
fi
exit "${failures}"
