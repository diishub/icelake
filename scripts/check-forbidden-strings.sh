#!/bin/sh
# Keep connection details for forbidden production data sources out of this
# repository. A committed flow definition, test fixture, example, or document
# must never carry a working pointer at a real PSU system, because that is how
# a development stack quietly ends up connected to real personal data.
#
# Matching is deliberately narrow: only strings that look like a connection
# target are refused -- a hostname after "://", "host=", "server=", and so on.
# Ordinary prose and email addresses that merely mention the domain are left
# alone, so the check stays quiet enough that nobody learns to skip it.
#
# Usage:
#   ./scripts/check-forbidden-strings.sh          scan staged changes (pre-commit)
#   ./scripts/check-forbidden-strings.sh --all    scan every tracked file (CI)
#   ./scripts/check-forbidden-strings.sh --file PATH   scan one file on disk
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

denylist="config/guardrail/forbidden-source-hosts.txt"
if [ ! -f "${denylist}" ]; then
  echo "Missing ${denylist}; refusing to continue" >&2
  exit 1
fi

scan_mode="${1:-staged}"
scan_file="${2:-}"
found_violation=0

# Anything that introduces a hostname as a connection target rather than as
# prose. Kept as one alternation so every entry gets the same treatment.
target_prefix='(://|[Hh]ost=|[Ss]erver=|[Dd]ata [Ss]ource=|jdbc:[a-z]+:)'

# Report only the matched connection target, never the surrounding line: a
# NiFi flow definition is a single enormous line, and printing it would bury
# the finding and risk echoing unrelated configuration.
report() {
  # Mask any user:password@ portion so the check itself never prints a secret.
  sed 's#://[^/@" ]*@#://<redacted>@#g' | sort -u | head -n 20
}

for entry in $(tr -d '\r' < "${denylist}" | sed 's/#.*//'); do
  escaped_entry="$(printf '%s' "${entry}" | sed 's/\./\./g')"
  pattern="${target_prefix}[A-Za-z0-9._-]*${escaped_entry}"
  matches=""

  case "${scan_mode}" in
    --all)
      for matched_file in $(git grep -lI --extended-regexp --ignore-case -- "${pattern}" \
        -- ':(exclude)'"${denylist}" || true); do
        matches="${matches}$(grep -oh --extended-regexp --ignore-case -- "${pattern}" \
          "${matched_file}" | sed "s|^|${matched_file}: |")
"
      done
      ;;
    --file)
      if [ -z "${scan_file}" ]; then
        echo "--file needs a path" >&2
        exit 1
      fi
      matches="$(grep -oh --extended-regexp --ignore-case -- "${pattern}" "${scan_file}" \
        | sed "s|^|${scan_file}: |" || true)"
      ;;
    *)
      matches="$(git diff --cached --unified=0 -- . ':(exclude)'"${denylist}" \
        | grep '^+' \
        | grep -oh --extended-regexp --ignore-case -- "${pattern}" || true)"
      ;;
  esac

  matches="$(printf '%s' "${matches}" | grep -v '^$' || true)"
  if [ -n "${matches}" ]; then
    found_violation=1
    echo "REFUSED: a connection target on the forbidden-source denylist appears" >&2
    echo "in the scanned content:" >&2
    printf '%s\n' "${matches}" | report >&2
  fi
done

if [ "${found_violation}" -ne 0 ]; then
  echo "" >&2
  echo "Point the configuration at an allowlisted host, or refer to the source" >&2
  echo "by name without a working connection string." >&2
  echo "See docs/SOURCE_GUARDRAIL_TH.md." >&2
  exit 1
fi

echo "PASS no forbidden connection target in the scanned content"
