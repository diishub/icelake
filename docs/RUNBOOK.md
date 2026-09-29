# Local Stack Runbook

## 1. Start

Allocate at least 12 GB RAM to Docker Desktop, then run from this directory:

```bash
chmod 600 .env
./scripts/validate-dev-env.sh
docker compose up -d --build
docker compose ps -a
./scripts/seed-dev-accounts.sh
./scripts/verify-dev-accounts.sh
```

The first pull/build can take tens of minutes because the upstream Trino, NiFi,
Polaris, and Superset images are large. Later starts reuse Docker's local image
cache. Follow bootstrap services with:

```bash
docker compose logs -f polaris-bootstrap polaris-setup dev-identity-setup superset-init
```

The stack is ready when the one-shot setup services exit with code 0, the
long-running services are healthy/running, and the identity verification script
finishes with `All configured development identity surfaces passed
verification`.

## 2. User entry and operator tools

Open <http://localhost:8085> for the Thai-first PSU Data Hub. This is the only
entry point that should be given to a beginner. It guides users by task and
deep-links authenticated users to the report list. The fictional preview is
clearly labelled and the initial no-data state is intentional.

The remaining URLs are operator tools on the server host. Credentials are read
from `.env`; never paste them into the portal, browser storage, tickets, or
chat.

- Superset: <http://localhost:8088>, then use `psu-admin`, `analyst`, or
  `viewer` with the corresponding `.env` password.
- Trino: <https://localhost:8086> (self-signed certificate, sign in with a
  configured identity). Override `TRINO_HOST_PORT` in `.env` if that
  host port is unavailable; services inside Compose continue to use port 8080.
- NiFi: <https://localhost:8443/nifi> using `NIFI_USERNAME` / `NIFI_PASSWORD`.
  The local self-signed certificate causes a browser warning.
- RustFS Console: <http://localhost:9001> using `RUSTFS_ACCESS_KEY` /
  `RUSTFS_SECRET_KEY`.
- Qdrant: <http://localhost:6333/dashboard> using `QDRANT_API_KEY` for API calls.

The platform section at the bottom of PSU Data Hub is shown only when the page
is opened using `localhost`. This is navigation convenience, not an access
control mechanism. The service login, loopback port binding, Trino groups, and
OPA policies are the actual controls.

## 3. Manage users and access

The three shared dev personas are desired state in `.env`. Reconcile and verify
them without printing credentials:

```bash
./scripts/seed-dev-accounts.sh
./scripts/verify-dev-accounts.sh
```

The seed recreates the ignored Trino group mapping through
`config/trino/render-groups.sh` and creates/updates the three Superset personas,
their exact roles and passwords. It does not delete a previous username or
rotate credentials for initialized infrastructure services.

Named pilot accounts are not provisioned yet. Do not edit
`runtime/trino/groups.txt` manually because it is generated and replaced on the
next seed run. See `docs/ENGINEER_HANDOFF_TH.md` before extending provisioning.

Data permissions are defined in `config/opa/trino.rego`. Validate tests before
restarting OPA:

```bash
docker compose run --rm opa check /policies/trino.rego
docker compose run --rm opa test /policies --verbose
docker compose restart opa
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
`documents` namespaces. OPA governs clients that query through Trino only. A
NiFi flow using Iceberg/Polaris/RustFS directly bypasses Trino/OPA; a dedicated
least-privilege Polaris/RustFS ingestion principal is not provisioned yet.

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
docker compose stop
docker compose up -d
```

Routine shutdown uses `stop` because the current mounts do not guarantee the
NiFi flow definition after its container is removed. Export/version the flow
before `docker compose down`, recreate, or image replacement. Bind-mounted state
remains under `runtime/`; do not delete that directory unless an explicit,
tested reset is intended.

## 8. Local-MVP limitations

- Single host; no HA, TLS mesh, backup automation or disaster recovery.
- Superset users and Trino groups are local test configuration, not PSU SSO.
- NiFi uses its local single-user administrator for this isolated workstation.
- NiFi repositories are mounted, but its flow definition is not yet guaranteed
  by the current mounts. Export/version a flow before recreating NiFi.
- NiFi ingestion flows and document embedding flows still need configuration and
  PSU-specific qualification.
- There is no governed publisher identity for `curated` to `published`, and no
  tested backup/restore procedure yet.
- Superset MCP must be tested with the selected AI client and model.
- Default `.env` values are development credentials and must never protect real
  PSU data.
