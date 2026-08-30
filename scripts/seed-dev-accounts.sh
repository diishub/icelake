#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

if [ ! -f .env ]; then
  echo "Missing .env; copy .env.example and replace every placeholder first" >&2
  exit 1
fi

chmod 600 .env
./scripts/validate-dev-env.sh

# Re-render the Trino authorization labels, then reconcile all local Superset
# human personas. NiFi and the remaining services use their own configured
# local credentials and are verified separately; no SSO is involved here.
docker compose run --rm --no-deps dev-identity-setup
docker compose run --rm --no-deps superset-init \
  python /app/pythonpath/bootstrap_users.py

# Apply the current Compose environment to the long-running identity-aware
# services. Compose recreates only services whose effective configuration
# changed, then the loop waits until all three are actually ready.
docker compose up -d --no-deps trino superset superset-mcp

services_ready=false
attempt=0
while [ "${attempt}" -lt 30 ]; do
  if docker compose exec -T trino curl --fail --silent \
       http://127.0.0.1:8080/v1/info >/dev/null 2>&1 && \
     docker compose exec -T superset curl --fail --silent \
       http://127.0.0.1:8088/health >/dev/null 2>&1 && \
     docker compose exec -T superset-mcp python -c \
       "import socket; socket.create_connection(('127.0.0.1', 5008), 2).close()" \
       >/dev/null 2>&1; then
    services_ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if [ "${services_ready}" != true ]; then
  echo "Timed out waiting for Trino, Superset, and Superset MCP after account seed" >&2
  exit 1
fi

echo "Dev account seed completed; run ./scripts/verify-dev-accounts.sh next"
