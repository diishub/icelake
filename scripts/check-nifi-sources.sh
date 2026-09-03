#!/bin/sh
# Check what the running NiFi canvas is actually pointed at.
#
# The .env guardrail only covers PSU_SOURCE_DB_*. A connection URL typed
# straight into a NiFi controller service never passes through .env, so it
# would otherwise reach a production system with nothing in the way. This
# closes that gap by reading the live flow definition back out of NiFi and
# checking every connection target in it against the same denylist.
#
# Also writes a timestamped copy of the flow definition under runtime/ (which
# is git-ignored), so exporting the canvas is a side effect of checking it
# rather than a separate thing to remember before a container is recreated.
set -eu

# Git Bash on Windows rewrites container-absolute paths in `docker compose
# exec` arguments unless this is set. Harmless everywhere else.
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

backup_dir="runtime/nifi-flow-backups"
mkdir -p "${backup_dir}"
flow_file="${backup_dir}/root-flow-$(date +%Y%m%d-%H%M%S).json"

# The token request and the download both run inside the container against
# its own loopback interface, so the single-user credentials never cross the
# host and never appear in a process list here.
docker compose exec -T nifi /bin/sh -ec '
  nifi_ip="$(hostname -i)"
  nifi_ip="${nifi_ip%% *}"
  token="$(curl --fail --silent --show-error --insecure \
    --resolve "localhost:8443:${nifi_ip}" \
    --request POST https://localhost:8443/nifi-api/access/token \
    --data-urlencode "username=${SINGLE_USER_CREDENTIALS_USERNAME}" \
    --data-urlencode "password=${SINGLE_USER_CREDENTIALS_PASSWORD}")"
  curl --fail --silent --show-error --insecure \
    --resolve "localhost:8443:${nifi_ip}" \
    --header "Authorization: Bearer ${token}" \
    "https://localhost:8443/nifi-api/process-groups/root/download?includeReferencedServices=true"
' > "${flow_file}"

if [ ! -s "${flow_file}" ]; then
  echo "Downloaded an empty flow definition from NiFi; refusing to pass" >&2
  exit 1
fi
echo "Flow definition saved to ${flow_file}"

./scripts/check-forbidden-strings.sh --file "${flow_file}"
echo "PASS the running NiFi canvas has no forbidden connection target"
