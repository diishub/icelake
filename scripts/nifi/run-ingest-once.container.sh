#!/bin/sh
# Runs inside the NiFi container; invoked by scripts/run-ingest-once.sh.
set -eu

GROUP_NAME="Metadata-Driven Ingest"

ip="$(hostname -i)"; ip="${ip%% *}"
base="https://localhost:8443/nifi-api"
token="$(curl -sf --insecure --resolve "localhost:8443:${ip}" \
  -X POST "${base}/access/token" \
  --data-urlencode "username=${SINGLE_USER_CREDENTIALS_USERNAME}" \
  --data-urlencode "password=${SINGLE_USER_CREDENTIALS_PASSWORD}")"

api() {
  method="$1"; path="$2"; shift 2
  curl -sf --insecure --resolve "localhost:8443:${ip}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -X "${method}" "${base}${path}" "$@"
}

group_id="$(api GET /flow/process-groups/root \
  | jq -r --arg n "${GROUP_NAME}" '.processGroupFlow.flow.processGroups[] | select(.component.name == $n) | .id')"
if [ -z "${group_id}" ]; then
  echo "process group [${GROUP_NAME}] does not exist; run ./scripts/build-ingest-flow.sh first" >&2
  exit 1
fi

# A processor that cannot start is a configuration error, not something to
# wait out, so report it before trying.
invalid="$(api GET "/process-groups/${group_id}/processors" \
  | jq -r '.processors[] | select(.component.validationStatus != "VALID")
           | "\(.component.name): \(.component.validationErrors // ["still validating"] | join("; "))"')"
if [ -n "${invalid}" ]; then
  echo "these processors are not valid yet:" >&2
  echo "${invalid}" >&2
  exit 1
fi

trigger_id="$(api GET "/process-groups/${group_id}/processors" \
  | jq -r '.processors[] | select(.component.name == "Trigger") | .id')"

echo "starting ${GROUP_NAME}"
jq -n --arg id "${group_id}" '{id:$id, state:"RUNNING"}' \
  | api PUT "/flow/process-groups/${group_id}" -d @- | jq -r .state

# One trigger firing is enough; stop it so the rest of the flow drains once.
sleep 3
revision="$(api GET "/processors/${trigger_id}" | jq -c .revision)"
jq -n --argjson rev "${revision}" --arg id "${trigger_id}" \
  '{revision:$rev, state:"STOPPED", disconnectedNodeAcknowledged:false}' \
  | api PUT "/processors/${trigger_id}/run-status" -d @- >/dev/null
echo "trigger stopped after one firing"

waited=0
while [ "${waited}" -lt 300 ]; do
  queued="$(api GET "/flow/process-groups/${group_id}/status?recursive=true" \
    | jq -r '.processGroupStatus.aggregateSnapshot | "\(.flowFilesQueued) \(.activeThreadCount)"')"
  set -- ${queued}
  if [ "$1" = "0" ] && [ "$2" = "0" ]; then
    sleep 3
    break
  fi
  sleep 3
  waited=$((waited + 3))
done
echo "queues drained after about ${waited}s"

jq -n --arg id "${group_id}" '{id:$id, state:"STOPPED"}' \
  | api PUT "/flow/process-groups/${group_id}" -d @- | jq -r .state
