#!/bin/sh
# Check the operations dashboard exists and that reading it goes through the
# same authorization path as everything else.
#
# The interesting case is the last one: the dashboard is useful precisely
# because it names source systems, tables and failure reasons, which is also
# why a report viewer must not be able to read it.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

. scripts/lib/trino.sh

failures=0

check() {
  case_name="$1"; expected="$2"; actual="$3"
  if [ "${actual}" = "${expected}" ]; then
    echo "PASS ${case_name}"
  else
    failures=$((failures + 1))
    echo "FAIL ${case_name}: expected '${expected}', got '${actual}'" >&2
  fi
}

superset_python() {
  docker compose exec -T superset python -c "$1" 2>/dev/null | tail -1
}

check "the dashboard exists with its three charts" "3" \
  "$(superset_python "
from superset.app import create_app
app = create_app()
with app.app_context():
    from superset import db
    from superset.models.dashboard import Dashboard
    d = db.session.query(Dashboard).filter_by(slug='psu-platform-operations').one_or_none()
    print(len(d.slices) if d else 'missing')
")"

check "the control-plane connection impersonates the signed-in user" "True" \
  "$(superset_python "
from superset.app import create_app
app = create_app()
with app.app_context():
    from superset import db
    from superset.models.core import Database
    x = db.session.query(Database).filter_by(database_name='PSU Platform Ops').one_or_none()
    print(x.impersonate_user if x else 'missing')
")"

check "the control-plane connection refuses writes" "False" \
  "$(superset_python "
from superset.app import create_app
app = create_app()
with app.app_context():
    from superset import db
    from superset.models.core import Database
    x = db.session.query(Database).filter_by(database_name='PSU Platform Ops').one_or_none()
    print(x.allow_dml if x else 'missing')
")"

trino_as() {
  trino_sql "$1" "$2" "$3" || true
}

analyst_user="$(grep '^PSU_ANALYST_USERNAME=' .env | cut -d= -f2)"
analyst_password="$(trino_password_for PSU_ANALYST_PASSWORD)"
viewer_user="$(grep '^PSU_VIEWER_1_USERNAME=' .env | cut -d= -f2)"
viewer_password="$(trino_password_for PSU_VIEWER_1_PASSWORD)"

analyst_read="$(trino_as "${analyst_user}" "${analyst_password}" 'SELECT count(*) FROM platform.ingest.ingest_run')"
case "${analyst_read}" in
  *"Access Denied"*) failures=$((failures + 1)); echo "FAIL an analyst can read run history: ${analyst_read}" >&2 ;;
  *) echo "PASS an analyst can read run history" ;;
esac

viewer_read="$(trino_as "${viewer_user}" "${viewer_password}" 'SELECT count(*) FROM platform.ingest.ingest_run')"
case "${viewer_read}" in
  *"Access Denied"*) echo "PASS a report viewer cannot read run history" ;;
  *) failures=$((failures + 1)); echo "FAIL a report viewer could read run history" >&2 ;;
esac

analyst_write="$(trino_as "${analyst_user}" "${analyst_password}" "INSERT INTO platform.ingest.source_system (source_key) VALUES ('x')")"
case "${analyst_write}" in
  *"Access Denied"*) echo "PASS an analyst cannot write to the control plane" ;;
  *) failures=$((failures + 1)); echo "FAIL an analyst write was not denied: ${analyst_write}" >&2 ;;
esac

if [ "${failures}" -ne 0 ]; then
  echo "${failures} operations dashboard test(s) failed" >&2
  exit 1
fi
echo "All operations dashboard tests passed"
