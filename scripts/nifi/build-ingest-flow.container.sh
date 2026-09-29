#!/bin/sh
# Runs inside the NiFi container; invoked by scripts/build-ingest-flow.sh.
#
# Idempotent at the process-group level: if the group already exists the
# script reports that and stops rather than building a second copy.
set -eu

GROUP_NAME="Metadata-Driven Ingest"
SCRIPT_DIR="/opt/nifi/nifi-current/ingest-scripts"
DRIVER_DIR="/opt/nifi/nifi-current/drivers"

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

existing="$(api GET /flow/process-groups/root \
  | jq -r --arg n "${GROUP_NAME}" '.processGroupFlow.flow.processGroups[] | select(.component.name == $n) | .id')"
if [ -n "${existing}" ]; then
  echo "process group [${GROUP_NAME}] already exists as ${existing}; nothing to build"
  exit 0
fi

credentials_id="$(api GET /flow/process-groups/root/controller-services \
  | jq -r '.controllerServices[] | select(.component.name == "RustFS Credentials") | .id')"
if [ -z "${credentials_id}" ]; then
  echo "the RustFS Credentials controller service is missing at the root level" >&2
  exit 1
fi

group_id="$(jq -n --arg name "${GROUP_NAME}" \
  '{revision:{version:0}, component:{name:$name, position:{x:0, y:0}}}' \
  | api POST "/process-groups/${root_id}/process-groups" -d @- | jq -r .id)"
echo "created process group ${group_id}"

make_processor() {
  jq -n --arg name "$1" --arg type "$2" --argjson x "$3" --argjson y "$4" \
        --argjson properties "$5" --argjson extra "$6" \
    '{revision:{version:0},
      component:{name:$name, type:$type, position:{x:$x, y:$y},
                 config: ({properties:$properties} + $extra)}}' \
  | api POST "/process-groups/${group_id}/processors" -d @- | jq -r .id
}

connect() {
  jq -n --arg src "$1" --arg dst "$2" --arg rel "$3" --arg gid "${group_id}" \
    '{revision:{version:0},
      component:{source:{id:$src, groupId:$gid, type:"PROCESSOR"},
                 destination:{id:$dst, groupId:$gid, type:"PROCESSOR"},
                 selectedRelationships:[$rel]}}' \
  | api POST "/process-groups/${group_id}/connections" -d @- >/dev/null
  echo "connected $3"
}

# ---------------------------------------------------------------------------
# Processors. Every one of them is plumbing; the decisions live in the two
# Groovy files and in the ingest.* registry tables.
# ---------------------------------------------------------------------------

trigger_id="$(make_processor "Trigger" \
  "org.apache.nifi.processors.standard.GenerateFlowFile" 0 0 \
  '{"File Size":"0B","Batch Size":"1"}' \
  '{"schedulingStrategy":"TIMER_DRIVEN","schedulingPeriod":"1 hour"}')"
echo "created Trigger ${trigger_id}"

extract_id="$(make_processor "Extract Safe Columns" \
  "org.apache.nifi.processors.groovyx.ExecuteGroovyScript" 0 200 \
  "$(jq -n --arg s "${SCRIPT_DIR}/extract_safe_columns.groovy" --arg c "${DRIVER_DIR}/*.jar" \
       '{"Script File":$s,"Additional Classpath":$c,"Failure Strategy":"rollback"}')" \
  '{"schedulingStrategy":"TIMER_DRIVEN","schedulingPeriod":"0 sec"}')"
echo "created Extract Safe Columns ${extract_id}"

stage_id="$(make_processor "PutS3Object (staging)" \
  "org.apache.nifi.processors.aws.s3.PutS3Object" 0 400 \
  "$(jq -n --arg cred "${credentials_id}" --arg bucket "${RUSTFS_BUCKET}" \
       '{"Bucket":$bucket,
         "Object Key":"${ingest.staging.key}",
         "AWS Credentials Provider Service":$cred,
         "Endpoint Override URL":"http://rustfs:9000",
         "Use Path Style Access":"true",
         "Region":"us-west-2"}')" \
  '{}')"
echo "created PutS3Object ${stage_id}"

load_id="$(make_processor "Load Into Iceberg (via Trino)" \
  "org.apache.nifi.processors.groovyx.ExecuteGroovyScript" 0 600 \
  "$(jq -n --arg s "${SCRIPT_DIR}/load_into_iceberg.groovy" --arg c "${DRIVER_DIR}/*.jar" \
       '{"Script File":$s,"Additional Classpath":$c,"Failure Strategy":"rollback"}')" \
  '{"schedulingStrategy":"TIMER_DRIVEN","schedulingPeriod":"0 sec"}')"
echo "created Load Into Iceberg ${load_id}"

results_id="$(make_processor "Log Results" \
  "org.apache.nifi.processors.standard.LogAttribute" 400 800 \
  '{"Log Level":"info","Attributes to Log Regular Expression":"ingest.*"}' \
  '{"autoTerminatedRelationships":["success"]}')"
echo "created Log Results ${results_id}"

failures_id="$(make_processor "Log Failures" \
  "org.apache.nifi.processors.standard.LogAttribute" -400 800 \
  '{"Log Level":"error","Attributes to Log Regular Expression":"ingest.*"}' \
  '{"autoTerminatedRelationships":["success"]}')"
echo "created Log Failures ${failures_id}"

# ---------------------------------------------------------------------------
# Wiring. Every failure relationship goes somewhere visible: nothing is
# auto-terminated silently except the two terminal log processors.
# ---------------------------------------------------------------------------
connect "${trigger_id}" "${extract_id}" "success"
connect "${extract_id}" "${stage_id}"   "success"
connect "${extract_id}" "${failures_id}" "failure"
connect "${stage_id}"   "${load_id}"    "success"
connect "${stage_id}"   "${failures_id}" "failure"
connect "${load_id}"    "${results_id}" "success"
connect "${load_id}"    "${failures_id}" "failure"

echo
echo "flow built in process group ${group_id}"
echo "it is stopped; start it from the canvas or with:"
echo "  ./scripts/run-ingest-once.sh"
