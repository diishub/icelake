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

# Processors validate asynchronously in background threads after creation.
# Wait for validation to finish before checking for configuration errors.
for _ in $(seq 1 30); do
  validating="$(api GET "/process-groups/${group_id}/processors" \
    | jq -r '.processors[] | select(.component.validationStatus == "VALIDATING") | .component.name')"
  if [ -z "${validating}" ]; then
    break
  fi
  sleep 2
done

invalid="$(api GET "/process-groups/${group_id}/processors" \
  | jq -r '.processors[] | select(.component.validationStatus != "VALID")
           | "\(.component.name): \(.component.validationErrors // ["still validating"] | join("; "))"')"
if [ -n "${invalid}" ]; then
  echo "these processors are not valid:" >&2
  echo "${invalid}" >&2
  exit 1
fi

trigger_id="$(api GET "/process-groups/${group_id}/processors" \
  | jq -r '.processors[] | select(.component.name == "Trigger") | .id')"

echo "starting ${GROUP_NAME}"
jq -n --arg id "${group_id}" '{id:$id, state:"RUNNING"}' \
  | api PUT "/flow/process-groups/${group_id}" -d @- | jq -r .state

# Wait for Trigger to actually fire (produce at least one flowfile out)
echo "waiting for Trigger to fire..."
for _ in $(seq 1 60); do
  out="$(api GET "/processors/${trigger_id}" | jq -r '.status.aggregateSnapshot.flowFilesOut // 0')"
  if [ "${out}" -gt 0 ]; then
    echo "trigger fired (${out} flowfile(s) generated)"
    break
  fi
  sleep 1
done

# One trigger firing is enough; stop it so the rest of the flow drains once.
revision="$(api GET "/processors/${trigger_id}" | jq -c .revision)"
jq -n --argjson rev "${revision}" --arg id "${trigger_id}" \
  '{revision:$rev, state:"STOPPED", disconnectedNodeAcknowledged:false}' \
  | api PUT "/processors/${trigger_id}/run-status" -d @- >/dev/null
echo "trigger stopped after one firing"

# Allow downstream processors a moment to start processing
sleep 5
waited=5
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
