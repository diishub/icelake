#!/bin/sh
# Runs inside the NiFi container; invoked by scripts/restore-ingest-flow.sh.
# Expects FLOW_FILE to point at a flow definition already copied in.
set -eu

: "${FLOW_FILE:?FLOW_FILE must point at a flow definition}"

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

root_id="$(api GET /flow/process-groups/root | jq -r .processGroupFlow.id)"

# A restored group is placed beside whatever is already on the canvas rather
# than merged into it, so a restore never silently overwrites working state.
# Reconciling the two is a deliberate step for whoever runs this.
restored_name="Restored $(date +%Y-%m-%d-%H%M%S)"

payload="$(jq -c --arg name "${restored_name}" \
  '{revision:{version:0},
    component:{name:$name, position:{x:1200, y:0}},
    versionedFlowSnapshot:{flowContents:.flowContents,
                           parameterContexts:(.parameterContexts // {}),
                           flowEncodingVersion:(.flowEncodingVersion // "1.0")}}' \
  "${FLOW_FILE}")"

group_id="$(printf '%s' "${payload}" | api POST "/process-groups/${root_id}/process-groups" -d @- | jq -r .id)"
if [ -z "${group_id}" ] || [ "${group_id}" = "null" ]; then
  echo "the restore was rejected by NiFi" >&2
  exit 1
fi

# NiFi names the imported group after the name inside the definition, not the
# one asked for, so rename it afterwards. Without this a restore is hard to
# tell apart from what was already on the canvas.
revision="$(api GET "/process-groups/${group_id}" | jq -c .revision)"
jq -n --argjson rev "${revision}" --arg id "${group_id}" --arg name "${restored_name}"   '{revision:$rev, component:{id:$id, name:$name}}'   | api PUT "/process-groups/${group_id}" -d @- >/dev/null

echo "restored into process group ${group_id} named [${restored_name}]"
api GET "/flow/process-groups/${group_id}" \
  | jq -r '.processGroupFlow.flow.processGroups[]? | "  contains: \(.component.name)"'
echo
echo "It is stopped. Check it against what is already on the canvas, then"
echo "delete whichever copy is not wanted."
  # Cleaning up is best effort: the file is small and the container is not
  # a place anything reads it from again.
rm -f "${FLOW_FILE}" 2>/dev/null || true
