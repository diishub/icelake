#!/bin/sh
# Runs inside the NiFi container; invoked by scripts/build-dotblue-flow.sh.
#
# Builds the file-source counterpart to "Metadata-Driven Ingest": it watches
# data/incoming/csv for the dotBlue aggregate extracts, archives each one into
# RustFS, and drives Trino to load it into polaris.raw.
#
# Idempotent at the process-group level: if the group already exists the
# script reports that and stops rather than building a second copy.
set -eu

GROUP_NAME="dotBlue Aggregates -> Iceberg"
SCRIPT_DIR="/opt/nifi/nifi-current/ingest-scripts"
DRIVER_DIR="/opt/nifi/nifi-current/drivers"
INCOMING_DIR="/data/incoming/csv"

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
  '{revision:{version:0}, component:{name:$name, position:{x:0, y:400}}}' \
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
# 1. Notice each extract. The mount is read-only, so this is ListFile +
#    FetchFile rather than GetFile, which would want to delete what it read.
#    The filter is anchored to the dotblue_ prefix so an unrelated CSV dropped
#    in the same folder is not swept into the lakehouse by accident.
# ---------------------------------------------------------------------------
list_id="$(make_processor "ListFile (data/incoming/csv)" \
  "org.apache.nifi.processors.standard.ListFile" 0 0 \
  "$(jq -n --arg dir "${INCOMING_DIR}" \
      '{"Input Directory":$dir,
        "File Filter":"dotblue_.*\\.csv",
        "Recurse Subdirectories":"false",
        "Minimum File Age":"5 sec"}')" \
  '{"schedulingPeriod":"60 sec","schedulingStrategy":"TIMER_DRIVEN"}')"
echo "ListFile ${list_id}"

fetch_id="$(make_processor "FetchFile" \
  "org.apache.nifi.processors.standard.FetchFile" 0 200 \
  '{"File to Fetch":"${absolute.path}/${filename}","Completion Strategy":"None"}' \
  '{}')"
echo "FetchFile ${fetch_id}"

# ---------------------------------------------------------------------------
# 2. Derive the target table from the file name and give the staged object a
#    directory of its own. external_location addresses a directory and Trino
#    reads every file under it, so two extracts sharing one prefix would be
#    unioned into whichever table loaded first.
# ---------------------------------------------------------------------------
attr_id="$(make_processor "Build Target + S3 Key" \
  "org.apache.nifi.processors.attributes.UpdateAttribute" 0 400 \
  '{"dotblue.table":"${filename:substringBeforeLast(\".csv\")}",
    "dotblue.run.id":"${UUID()}",
    "dotblue.s3.key":"staging/dotblue/${filename:substringBeforeLast(\".csv\")}/${UUID()}/${filename}"}' \
  '{}')"
echo "UpdateAttribute ${attr_id}"

# Endpoint Override URL is what points this at RustFS. Without it the AWS SDK
# resolves the real s3.<region>.amazonaws.com and the request is rejected with
# "The AWS Access Key Id you provided does not exist in our records" -- a 403
# from Amazon, not from RustFS, which reads like a credential problem and is
# not one. Verified live while building this flow.
put_id="$(make_processor "PutS3Object (staging)" \
  "org.apache.nifi.processors.aws.s3.PutS3Object" 0 600 \
  "$(jq -n --arg cred "${credentials_id}" \
      '{"Bucket":"${RUSTFS_BUCKET}",
        "Object Key":"${dotblue.s3.key}",
        "Region":"us-west-2",
        "AWS Credentials Provider Service":$cred,
        "Endpoint Override URL":"http://rustfs:9000"}')" \
  '{}')"
echo "PutS3Object ${put_id}"

# ---------------------------------------------------------------------------
# 3. The Trino bridge. All of the decisions -- target schema, column types,
#    audit columns, refresh semantics -- live in the script and its JSON, not
#    on the canvas.
# ---------------------------------------------------------------------------
load_id="$(make_processor "Load into Iceberg (Trino)" \
  "org.apache.nifi.processors.groovyx.ExecuteGroovyScript" 0 800 \
  "$(jq -n --arg f "${SCRIPT_DIR}/load_csv_into_iceberg.groovy" --arg cp "${DRIVER_DIR}" \
      '{"Script File":$f, "Additional classpath":$cp}')" \
  '{"autoTerminatedRelationships":["success"]}')"
echo "ExecuteGroovyScript ${load_id}"

log_id="$(make_processor "Log Failures" \
  "org.apache.nifi.processors.standard.LogAttribute" 500 800 \
  '{"Log Level":"warn","Log Payload":"false","Log FlowFile Properties":"true"}' \
  '{"autoTerminatedRelationships":["success"]}')"
echo "LogAttribute ${log_id}"

connect "${list_id}"  "${fetch_id}" success
connect "${fetch_id}" "${attr_id}"  success
connect "${fetch_id}" "${log_id}"   failure
connect "${fetch_id}" "${log_id}"   not.found
connect "${fetch_id}" "${log_id}"   permission.denied
connect "${attr_id}"  "${put_id}"   success
connect "${put_id}"   "${load_id}"  success
connect "${put_id}"   "${log_id}"   failure
connect "${load_id}"  "${log_id}"   failure

echo "built [${GROUP_NAME}] as ${group_id}"
