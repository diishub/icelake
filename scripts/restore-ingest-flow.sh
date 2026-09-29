#!/bin/sh
# Restore a NiFi flow from a saved flow definition.
#
# The pair to scripts/check-nifi-sources.sh, which writes those definitions to
# runtime/nifi-flow-backups every time it checks the canvas. Restoring is the
# half that is easy to assume works and expensive to discover does not, so it
# has its own script and its own test.
#
# The restored flow arrives stopped, and its source hosts are checked before
# anything can run: a backup taken before the guardrail existed could name a
# host that is no longer allowed.
#
# Usage:
#   ./scripts/restore-ingest-flow.sh                     restore the newest backup
#   ./scripts/restore-ingest-flow.sh path/to/flow.json   restore a specific one
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

backup="${1:-}"
if [ -z "${backup}" ]; then
  backup="$(ls -t runtime/nifi-flow-backups/*.json 2>/dev/null | head -1 || true)"
fi
if [ -z "${backup}" ] || [ ! -s "${backup}" ]; then
  echo "no flow definition to restore; run ./scripts/check-nifi-sources.sh to take one" >&2
  exit 1
fi
echo "restoring from ${backup}"

# Refuse a backup that would put a forbidden connection target back on the
# canvas. This is the case the guardrail would otherwise miss entirely: the
# host never passes through .env, it arrives inside the flow definition.
./scripts/check-forbidden-strings.sh --file "${backup}"

# The definition and the script both need to reach the container, and a shell
# has only one standard input, so the definition goes in as a file.
docker compose cp "${backup}" nifi:/tmp/restore-flow.json
docker compose exec -T -e FLOW_FILE=/tmp/restore-flow.json nifi /bin/sh -s \
  < scripts/nifi/restore-ingest-flow.container.sh
