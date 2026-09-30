#!/bin/sh
# Refuse to start database ingestion against a host that has not been
# approved for this development stack.
#
# Runs in two places from this single copy, so the rule cannot drift:
#   - the `source-guard` Compose service, which NiFi depends on, so an
#     unapproved host stops the container from starting at all;
#   - scripts/validate-dev-env.sh, which reads the values out of .env.
#
# Inputs (environment):
#   PSU_SOURCE_DB_HOST                 source hostname, empty = ingestion off
#   PSU_SOURCE_DB_CREDENTIALS_PRESENT  non-empty if any other PSU_SOURCE_DB_*
#                                      value is set; deliberately a flag and
#                                      not the credentials themselves, so no
#                                      secret is passed into this container
#   GUARDRAIL_DIR                      directory holding the two list files
#
# Prints no configuration values other than the hostname, which is not a
# secret and is what the operator needs in order to fix the problem.
set -eu

guardrail_dir="${GUARDRAIL_DIR:-/guardrail}"
allowlist="${guardrail_dir}/allowed-source-hosts.txt"
denylist="${guardrail_dir}/forbidden-source-hosts.txt"

for list_file in "${allowlist}" "${denylist}"; do
  if [ ! -f "${list_file}" ]; then
    echo "Guardrail list ${list_file} is missing; refusing to continue" >&2
    exit 1
  fi
done

# Normalize: lowercase, drop a trailing :port, drop surrounding quotes and
# any stray carriage return from a file edited on Windows.
host="$(printf '%s' "${PSU_SOURCE_DB_HOST:-}" | tr -d '\r "'"'" | tr 'A-Z' 'a-z')"
host="${host%%:*}"

if [ -z "${host}" ]; then
  if [ -n "${PSU_SOURCE_DB_CREDENTIALS_PRESENT:-}" ]; then
    echo "PSU_SOURCE_DB_HOST is empty but other PSU_SOURCE_DB_* values are set." >&2
    echo "A half-configured source is treated as a mistake, not as 'disabled'." >&2
    echo "Clear every PSU_SOURCE_DB_* value in .env, or set all of them." >&2
    exit 1
  fi
  echo "PASS database ingestion source is disabled"
  exit 0
fi

# Denylist first, and it wins over the allowlist: reaching a forbidden host
# must require editing both files, in a commit someone else can see.
for entry in $(tr -d '\r' < "${denylist}" | sed 's/#.*//'); do
  if [ "${host}" = "${entry}" ] || [ "${host}" != "${host%".${entry}"}" ]; then
    echo "REFUSED: ${host} is a forbidden ingestion source." >&2
    echo "It holds real PSU personnel/student records and this stack is a" >&2
    echo "development environment (no Trino authentication, no SSO, no TLS" >&2
    echo "between services, no tested restore). Clear PSU_SOURCE_DB_* in .env." >&2
    echo "See docs/SOURCE_GUARDRAIL_TH.md." >&2
    exit 1
  fi
done

if ! tr -d '\r' < "${allowlist}" | grep -qxF "${host}"; then
  echo "REFUSED: ${host} is not listed in config/guardrail/allowed-source-hosts.txt." >&2
  echo "Ingestion sources are allowlisted, so an unlisted host is refused" >&2
  echo "rather than attempted. See docs/SOURCE_GUARDRAIL_TH.md for what has" >&2
  echo "to be approved before a host is added." >&2
  exit 1
fi

echo "PASS ingestion source host ${host} is allowlisted"
