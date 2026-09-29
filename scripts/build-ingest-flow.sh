#!/bin/sh
# Build the metadata-driven ingestion flow on the NiFi canvas.
#
# The flow is described in source rather than clicked together, so it can be
# rebuilt after a container is replaced and so a change to it shows up in a
# diff. The processors carry no logic themselves: the two ExecuteGroovyScript
# steps point at files in config/nifi/scripts.
#
# The work happens inside the NiFi container, where curl and jq are available
# and the API is reachable on its own loopback interface, so the single-user
# credentials never cross the host.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

docker compose exec -T nifi /bin/sh -s < scripts/nifi/build-ingest-flow.container.sh
