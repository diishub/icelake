#!/bin/sh
# Acceptance tests for the ingestion source guardrail.
#
# These exercise config/guardrail/check-source.sh directly with temporary
# copies of the two list files, so no real .env value is read and nothing on
# the running stack is touched. Run after changing the guardrail, the lists,
# or the way the Compose service passes its environment in.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
cp config/guardrail/allowed-source-hosts.txt \
   config/guardrail/forbidden-source-hosts.txt "${work_dir}/"

forbidden_host="$(tr -d '\r' < config/guardrail/forbidden-source-hosts.txt \
  | sed 's/#.*//' | tr -s ' \t\n' '\n' | grep -v '^$' | head -n 1)"
if [ -z "${forbidden_host}" ]; then
  echo "The denylist is empty, so these tests would prove nothing" >&2
  exit 1
fi

failures=0

run_case() {
  case_name="$1"
  expected_exit="$2"
  case_host="$3"
  case_credentials="$4"
  case_dir="$5"

  set +e
  output="$(PSU_SOURCE_DB_HOST="${case_host}" \
    PSU_SOURCE_DB_CREDENTIALS_PRESENT="${case_credentials}" \
    GUARDRAIL_DIR="${case_dir}" \
    sh config/guardrail/check-source.sh 2>&1)"
  actual_exit=$?
  set -e

  if [ "${actual_exit}" -eq "${expected_exit}" ]; then
    echo "PASS ${case_name}"
  else
    failures=$((failures + 1))
    echo "FAIL ${case_name}: expected exit ${expected_exit}, got ${actual_exit}" >&2
    printf '%s\n' "${output}" >&2
  fi
}

run_case "an unset source is disabled, not refused"        0 "" ""            "${work_dir}"
run_case "a half-configured source is refused"             1 "" "password"    "${work_dir}"
run_case "an allowlisted host is accepted"                 0 "source-sim" "user" "${work_dir}"
run_case "a forbidden host is refused"                     1 "${forbidden_host}" "user" "${work_dir}"
run_case "a subdomain of a forbidden host is refused"      1 "db.${forbidden_host}" "user" "${work_dir}"
run_case "a forbidden host is refused case-insensitively"  1 "$(printf '%s' "${forbidden_host}" | tr 'a-z' 'A-Z')" "user" "${work_dir}"
run_case "a host:port form is normalized before matching"  1 "${forbidden_host}:5432" "user" "${work_dir}"
run_case "an unlisted host is refused"                     1 "not-approved.example.edu" "user" "${work_dir}"

# The denylist has to win even when someone also adds the host to the
# allowlist, so reaching a forbidden source needs two reviewable edits.
both_dir="${work_dir}/both"
mkdir -p "${both_dir}"
cp "${work_dir}/allowed-source-hosts.txt" "${work_dir}/forbidden-source-hosts.txt" "${both_dir}/"
printf '%s\n' "${forbidden_host}" >> "${both_dir}/allowed-source-hosts.txt"
run_case "the denylist wins over the allowlist"            1 "${forbidden_host}" "user" "${both_dir}"

# A missing list file must fail closed rather than allowing everything.
empty_dir="${work_dir}/empty"
mkdir -p "${empty_dir}"
run_case "a missing guardrail list refuses everything"     1 "source-sim" "user" "${empty_dir}"

if [ "${failures}" -ne 0 ]; then
  echo "${failures} guardrail test(s) failed" >&2
  exit 1
fi
echo "All ingestion source guardrail tests passed"
