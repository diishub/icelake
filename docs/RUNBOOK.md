# Local Stack Runbook

## 1. Start

Allocate at least 12 GB RAM to Docker Desktop, then run from this directory:

```bash
docker compose up -d --build
docker compose ps
```

The first pull/build can take tens of minutes because the upstream Trino, NiFi,
Polaris, and Superset images are large. Later starts reuse Docker's local image
cache. Follow bootstrap services with:

```bash
docker compose logs -f polaris-bootstrap polaris-setup superset-init
```

The stack is ready when `polaris-setup` and `superset-init` exit with code 0 and
the long-running services are healthy/running.

## 2. Entry points and local credentials

Open <http://localhost:8085> for links to all interfaces. Credentials are read
from `.env`.

- Superset: <http://localhost:8088>, then use `psu-admin`, `analyst`, or
  `viewer` with the corresponding `.env` password.
- Trino: <http://localhost:8086>. Override `TRINO_HOST_PORT` in `.env` if that
  host port is unavailable; services inside Compose continue to use port 8080.
- NiFi: <https://localhost:8443/nifi> using `NIFI_USERNAME` / `NIFI_PASSWORD`.
  The local self-signed certificate causes a browser warning.
- RustFS Console: <http://localhost:9001> using `RUSTFS_ACCESS_KEY` /
  `RUSTFS_SECRET_KEY`.
- Qdrant: <http://localhost:6333/dashboard> using `QDRANT_API_KEY` for API calls.

## 3. Manage users and access

1. In Superset as `psu-admin`, open **Settings → Security → List Users**.
2. Add the user with only the required Superset role (`Admin`, `Alpha`, or
   `Gamma`).
3. Add the same username to the matching PSU group line in
   `config/trino/groups.txt`. Trino reloads it within five seconds.
4. Data permissions are defined in `config/opa/trino.rego`. OPA reload requires:

```bash
docker compose restart opa
```

Validate a changed policy before restarting:

```bash
docker compose run --rm opa check /policies/trino.rego
```

Do not grant broader Superset access as a substitute for Trino/OPA policy. The
query engine remains the data-security boundary.

## 4. Ingest structured data

Place CSV files under `data/incoming/csv`; NiFi sees them read-only at
`/data/incoming/csv`.

Use NiFi 2.10 processors/controller services:

- `ListFile`/`FetchFile` plus `CSVReader` for CSV;
- `QueryDatabaseTableRecord` plus a JDBC connection pool for database sync;
- `RESTIcebergCatalog`, `S3IcebergFileIOProvider`, `ParquetIcebergWriter`, and
  `PutIcebergRecord` for Iceberg writes through Polaris.

Put database JDBC driver JARs under `drivers/`. PostgreSQL/MySQL drivers may be
downloaded from their upstream projects. Oracle's driver must be supplied under
Oracle's license and is intentionally not redistributed here.

The initialized Polaris catalog is `psu`, with `raw`, `curated`, `published`, and
`documents` namespaces. Ingestion identities may write only the namespaces
allowed by OPA.

## 5. Documents and vectors

Place original documents under `data/incoming/documents`. NiFi can preserve them
in RustFS and send extracted chunks/embeddings to Qdrant. The services are
running, but extraction, chunking and embedding flows are not pre-seeded because
model choice and PSU document classification rules must be agreed first.

Originals and governed chunk metadata belong in object storage/Iceberg. Qdrant
is only a rebuildable index.

## 6. Superset and AI prompts

`superset-init` creates a `PSU Iceberg` Trino connection with user impersonation.
The MCP endpoint is <http://localhost:5008/mcp>. For local testing it is bound to
`127.0.0.1`, has MCP authentication disabled, and executes as `analyst`. Never
expose this endpoint on a network. When PSU SSO is added, enable JWT validation
against the PSU OAuth2 issuer and propagate the authenticated user.

AI-generated SQL and dashboards must be reviewed before saving or publishing.

## 7. Stop and restart

```bash
docker compose down
docker compose up -d
```

State remains under `runtime/`. Do not delete that directory unless an explicit,
tested reset is intended.

## 8. Local-MVP limitations

- Single host; no HA, TLS mesh, backup automation or disaster recovery.
- Superset users and Trino groups are local test configuration, not PSU SSO.
- NiFi uses its local single-user administrator for this isolated workstation.
- NiFi ingestion flows and document embedding flows still need configuration and
  PSU-specific qualification.
- Superset MCP must be tested with the selected AI client and model.
- Default `.env` values are development credentials and must never protect real
  PSU data.
