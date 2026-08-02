#!/bin/sh
set -eu

apk add --no-cache jq >/dev/null

token_response="$(curl --fail-with-body --silent --show-error \
  --request POST http://polaris:8181/api/catalog/v1/oauth/tokens \
  --header "Polaris-Realm: ${POLARIS_REALM}" \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=${POLARIS_CLIENT_ID}" \
  --data-urlencode "client_secret=${POLARIS_CLIENT_SECRET}" \
  --data-urlencode 'scope=PRINCIPAL_ROLE:ALL')"
token="$(printf '%s' "${token_response}" | jq -r '.access_token')"

if [ -z "${token}" ] || [ "${token}" = null ]; then
  echo "Polaris did not return an access token" >&2
  exit 1
fi

auth_header="Authorization: Bearer ${token}"
realm_header="Polaris-Realm: ${POLARIS_REALM}"
management_url="http://polaris:8181/api/management/v1"
catalog_url="http://polaris:8181/api/catalog/v1/${POLARIS_CATALOG}"

if ! curl --fail --silent --output /dev/null \
  --header "${auth_header}" \
  --header "${realm_header}" \
  "${management_url}/catalogs/${POLARIS_CATALOG}"; then
  jq --null-input \
    --arg catalog "${POLARIS_CATALOG}" \
    --arg bucket "${RUSTFS_BUCKET}" \
    '{catalog: {
      name: $catalog,
      type: "INTERNAL",
      readOnly: false,
      properties: {"default-base-location": ("s3://" + $bucket)},
      storageConfigInfo: {
        storageType: "S3",
        allowedLocations: [("s3://" + $bucket)],
        endpoint: "http://localhost:9000",
        endpointInternal: "http://rustfs:9000",
        pathStyleAccess: true,
        region: "us-west-2"
      }
    }}' >/tmp/catalog.json

  curl --fail-with-body --silent --show-error \
    --request POST "${management_url}/catalogs" \
    --header "${auth_header}" \
    --header "${realm_header}" \
    --header 'Content-Type: application/json' \
    --data-binary @/tmp/catalog.json >/dev/null
  echo "Created Polaris catalog ${POLARIS_CATALOG}"
else
  echo "Polaris catalog ${POLARIS_CATALOG} already exists"
fi

for namespace in raw curated published documents; do
  namespace_json="$(jq --null-input --arg namespace "${namespace}" \
    '{namespace: [$namespace], properties: {}}')"
  status="$(curl --silent --output /tmp/namespace-response.json --write-out '%{http_code}' \
    --request POST "${catalog_url}/namespaces" \
    --header "${auth_header}" \
    --header "${realm_header}" \
    --header 'Content-Type: application/json' \
    --data "${namespace_json}")"
  case "${status}" in
    200|201|204|409) ;;
    *)
      cat /tmp/namespace-response.json >&2
      exit 1
      ;;
  esac
done

echo "Polaris namespaces are ready"
