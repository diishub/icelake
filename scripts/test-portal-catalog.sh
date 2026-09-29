#!/bin/sh
# Assert the portal catalogue publishes what the portal needs and nothing more.
#
# The interesting cases are not that the file parses. They are that the
# boundary between the control plane and a file every browser can read stays
# where it was drawn: no source host, no credential prefix, no raw run error,
# and no value from an ingested row.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

catalog="portal/data/catalog.json"
failures=0

pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1" >&2; }

expect_equals() {
  if [ "$3" = "$2" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}

expect_absent() {
  if grep -qi -- "$2" "${catalog}"; then
    fail "$1: '$2' appears in the published catalogue"
  else
    pass "$1"
  fi
}

# ---------------------------------------------------------------------------
# The publisher runs and produces a document
# ---------------------------------------------------------------------------

if ./scripts/publish-portal-catalog.sh >/dev/null 2>&1; then
  pass "the publisher completes"
else
  fail "the publisher completes"
fi

if [ -s "${catalog}" ]; then pass "the catalogue is written"; else fail "the catalogue is written"; fi

for key in '"generated_at"' '"stats"' '"domains"' '"datasets"'; do
  if grep -q -- "${key}" "${catalog}"; then
    pass "the document carries ${key}"
  else
    fail "the document carries ${key}"
  fi
done

# ---------------------------------------------------------------------------
# What must never cross the boundary
# ---------------------------------------------------------------------------
#
# The last two are the September incident written down as a test: the real
# warehouse hostname must never reach a file served to a browser, whatever
# else changes about the publisher.

expect_absent "no credential environment prefix is published" "credentials_env_prefix"
expect_absent "no password field is published"                "password"
expect_absent "no raw run error text is published"            "error_message"
expect_absent "no source host is published"                   "\"host\""
expect_absent "no forbidden domain is published"              "psu\.ac\.th"
expect_absent "no forbidden warehouse name is published"      "lakedb"

# ---------------------------------------------------------------------------
# The document says what the registry says
# ---------------------------------------------------------------------------

declared_total="$(sed -n 's/.*"datasets_total"[^0-9]*\([0-9][0-9]*\).*/\1/p' "${catalog}")"
actual_total="$(grep -o '"availability"' "${catalog}" | wc -l | tr -d ' ')"
expect_equals "datasets_total matches the number of datasets" "${declared_total}" "${actual_total}"

unknown_states="$(grep -o '"availability" *: *"[a-z]*"' "${catalog}" \
  | sed 's/.*"\([a-z]*\)"$/\1/' | sort -u \
  | grep -vx 'published\|withheld\|pending\|retired' | tr '\n' ' ' | sed 's/ $//')"
expect_equals "every availability value is one the portal can render" "" "${unknown_states}"

# ---------------------------------------------------------------------------
# The view is the boundary, not the script
# ---------------------------------------------------------------------------
#
# Filtering in the publisher could be widened by anyone editing a SELECT list.
# The view is what makes the omission structural, so it is asserted directly.

platform_password="$(grep '^PLATFORM_DB_PASSWORD=' .env | cut -d= -f2-)"

leaked_columns="$(printf "%s\n" \
  "SELECT string_agg(column_name, ' ' ORDER BY column_name)
     FROM information_schema.columns
    WHERE table_schema = 'ingest' AND table_name = 'v_portal_catalog'
      AND column_name IN ('host', 'port', 'credentials_env_prefix', 'error_message', 'database_name');" \
  | docker compose exec -T -e PGPASSWORD="${platform_password}" postgres \
      psql --host 127.0.0.1 --username platform_app --dbname platform \
        --no-align --tuples-only --quiet --no-psqlrc -f - | tr -d '\r')"
expect_equals "the catalogue view exposes no connection detail" "" "${leaked_columns}"

if [ "${failures}" -eq 0 ]; then
  echo "all portal catalogue cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
