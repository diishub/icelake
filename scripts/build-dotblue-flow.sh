#!/bin/sh
# Build the dotBlue aggregate ingestion flow on the NiFi canvas.
#
# The file-source counterpart to build-ingest-flow.sh: it watches
# data/incoming/csv, archives each extract into RustFS and drives Trino to
# load it into polaris.raw. Described in source rather than clicked together,
# for the same reasons: it survives a container replacement and a change to it
# shows up in a diff. The processors carry no logic themselves -- the
# ExecuteGroovyScript step points at config/nifi/scripts.
#
# The work happens inside the NiFi container, where curl and jq are available
# and the API is reachable on its own loopback interface, so the single-user
# credentials never cross the host.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

docker compose exec -T nifi /bin/sh -s < scripts/nifi/build-dotblue-flow.container.sh
