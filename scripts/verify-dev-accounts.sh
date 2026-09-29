#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

. scripts/lib/trino.sh
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

./scripts/validate-dev-env.sh

# The host-side guardrail ran inside validate-dev-env.sh above. Run the
# container-side one too, so a broken mount or a missing dependency in
# compose.yaml is caught here rather than at the next `docker compose up`.
docker compose run --rm --no-deps source-guard >/dev/null
echo "PASS the configured ingestion source host is approved by the guardrail"

# .env is only one of the two ways a source can be configured. Check what
# the live NiFi canvas is pointed at as well, and keep a copy of the flow
# definition while doing it.
./scripts/check-nifi-sources.sh

# The synthetic source and the ingestion control plane are part of the
# acceptance surface too: one holds the cases the pipeline must handle, the
# other holds the privilege boundary the pipeline runs inside.
./scripts/test-trino-auth.sh
./scripts/test-source-sim.sh
./scripts/test-platform-registry.sh
./scripts/test-maintenance.sh
./scripts/test-ops-dashboard.sh

docker compose run --rm --no-deps superset-init \
  python /app/pythonpath/verify_dev_users.py
docker compose run --rm --no-deps --entrypoint /bin/sh trino \
  -ec /etc/trino/verify-dev-groups.sh

docker compose run --rm --no-deps opa test /policies --verbose

# Every identity has to prove its username now, so this checks the credential
# as well as the authorization. Run from the host, one credential at a time,
# so the query engine container never has to hold them all.
check_trino_identity() {
  identity_user="$1"
  identity_password="$(trino_password_for "$2")"
  identity_result="$(trino_sql "${identity_user}" "${identity_password}" 'SELECT current_user')"
  case "${identity_result}" in
    *"${identity_user}"*) ;;
    *)
      echo "Trino identity ${identity_user} could not start an authorized query" >&2
      printf '%s\n' "${identity_result}" >&2
      exit 1
      ;;
  esac
}

check_trino_identity "$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)" PSU_ADMIN_PASSWORD
check_trino_identity "$(grep '^PSU_ANALYST_USERNAME=' .env | cut -d= -f2)" PSU_ANALYST_PASSWORD
check_trino_identity "$(grep '^TRINO_INGESTION_USERNAME=' .env | cut -d= -f2)" TRINO_INGESTION_PASSWORD
check_trino_identity "$(grep '^TRINO_MAINTENANCE_USERNAME=' .env | cut -d= -f2)" TRINO_MAINTENANCE_PASSWORD

viewer_count="$(grep '^PSU_VIEWER_COUNT=' .env | cut -d= -f2)"
viewer_index=1
while [ "${viewer_index}" -le "${viewer_count}" ]; do
  check_trino_identity \
    "$(grep "^PSU_VIEWER_${viewer_index}_USERNAME=" .env | cut -d= -f2)" \
    "PSU_VIEWER_${viewer_index}_PASSWORD"
  viewer_index=$((viewer_index + 1))
done
echo "PASS every Trino identity can authenticate and start an authorized query"

# The property that used to be missing entirely: asserting a username is no
# longer enough. This is the check that would have caught the exposure that
# made the guardrail work necessary.
spoof_result="$(trino_sql "$(grep '^PSU_ADMIN_USERNAME=' .env | cut -d= -f2)" "definitely-not-the-password" 'SELECT 1' || true)"
case "${spoof_result}" in
  *"Invalid credentials"*|*"Access Denied"*|*"401"*)
    echo "PASS Trino refuses an asserted username without its password"
    ;;
  *)
    echo "Trino accepted a query without a valid credential" >&2
    printf '%s\n' "${spoof_result}" >&2
    exit 1
    ;;
esac

docker compose exec -T nifi /bin/sh -ec \
  'nifi_ip="$(hostname -i)"
   nifi_ip="${nifi_ip%% *}"
   curl --fail --silent --show-error --insecure \
     --resolve "localhost:8443:${nifi_ip}" \
     --request POST https://localhost:8443/nifi-api/access/token \
     --data-urlencode "username=${SINGLE_USER_CREDENTIALS_USERNAME}" \
     --data-urlencode "password=${SINGLE_USER_CREDENTIALS_PASSWORD}" >/dev/null'
echo "PASS NiFi local dev administrator password verified"

docker compose exec -T postgres /bin/sh -ec \
  'PGPASSWORD="${POSTGRES_PASSWORD}" \
   psql --host 127.0.0.1 --username "${POSTGRES_USER}" --dbname postgres \
     --no-align --tuples-only --set ON_ERROR_STOP=1 \
     --command "SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcanlogin" \
     | grep -qx 1'
echo "PASS PostgreSQL service login and password verified"

docker compose run --rm bucket-setup >/dev/null
echo "PASS RustFS service credentials verified by bucket access"

docker compose run --rm polaris-setup >/dev/null
echo "PASS Polaris service client verified by catalog setup check"

qdrant_key="$(docker compose exec -T qdrant printenv QDRANT__SERVICE__API_KEY)"
qdrant_unauth_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:6333/collections)"
qdrant_auth_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "api-key: ${qdrant_key}" http://127.0.0.1:6333/collections)"
unset qdrant_key
if [ "${qdrant_unauth_status}" != "401" ] || [ "${qdrant_auth_status}" != "200" ]; then
  echo "Qdrant API-key boundary did not return the expected 401/200 responses" >&2
  exit 1
fi
echo "PASS Qdrant rejects no-key access and accepts the configured API key"

mcp_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST http://127.0.0.1:5008/mcp \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"psu-dev-verifier","version":"1"}}}')"
if [ "${mcp_status}" != "200" ]; then
  echo "Superset MCP did not accept the expected unauthenticated loopback initialize request" >&2
  exit 1
fi
docker compose exec -T superset-mcp python -c \
  'import superset_config; assert superset_config.MCP_AUTH_ENABLED is False; assert superset_config.MCP_DEV_USERNAME == __import__("os").environ["PSU_ANALYST_USERNAME"]'
echo "PASS Superset MCP is in the documented unauthenticated analyst dev mode"

echo "All configured development identity surfaces passed verification"
