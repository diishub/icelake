# PSU Open Lakehouse

PSU Open Lakehouse is a local, open-source data platform for learning and
testing governed ingestion, Apache Iceberg storage, SQL analytics, dashboards,
and AI-assisted data access. The repository contains Docker Compose
configuration, service configuration, and access policy; it is not a custom
application.

The main data path is:

```text
CSV / database / documents
          |
          v
        NiFi  ---> Qdrant (rebuildable document-vector index)
          |
          v
Apache Iceberg + Polaris catalog + RustFS object storage
          |
          v
        Trino ---> OPA authorization ---> Superset / Superset MCP
```

## 1. Requirements

- Docker Desktop with Docker Compose v2
- At least 12 GB of memory allocated to Docker Desktop
- Approximately 20 GB of free disk space for images and local runtime data

Run every command below from this repository directory.

## 2. Configure the local environment

The real local configuration is stored in `.env`, which is intentionally
ignored by Git. If it does not exist, create it from the example:

```bash
cp .env.example .env
```

Replace every `change-me` value before loading any non-demo data. Choose the
passwords before the first startup: changing `.env` later does not automatically
change passwords for Superset users that already exist in PostgreSQL.

## 3. Start the complete stack

The first start pulls several large images and builds the Superset image, so it
can take tens of minutes:

```bash
docker compose up -d --build
```

Watch the one-time initialization services:

```bash
docker compose logs -f polaris-bootstrap polaris-setup superset-init
```

In another terminal, inspect all containers:

```bash
docker compose ps -a
```

The stack is ready when:

- `polaris-bootstrap`, `polaris-setup`, `bucket-setup`, and `superset-init`
  show `Exited (0)`;
- Polaris, PostgreSQL, Redis, Trino, Superset, and Superset MCP are healthy;
- the remaining long-running services show `Up`.

`Exited (0)` is the expected successful state for those one-time setup
containers. It does not mean the stack stopped.

Open the control page after startup:

<http://localhost:8085>

## 4. Seeded usernames and passwords

Passwords are not hard-coded in this README. The source of truth is your local
`.env` file so credentials are not accidentally committed.

| Service | Seeded username or key | Password setting in `.env` | Purpose |
|---|---|---|---|
| Superset | `psu-admin` by default | `PSU_ADMIN_PASSWORD` | Full local administrator |
| Superset | `analyst` by default | `PSU_ANALYST_PASSWORD` | Read `curated` and `published` |
| Superset | `viewer` by default | `PSU_VIEWER_PASSWORD` | Read `published` only |
| NiFi | `psu-admin` by default | `NIFI_PASSWORD` | NiFi single-user administrator |
| RustFS | value of `RUSTFS_ACCESS_KEY` | `RUSTFS_SECRET_KEY` | Object-storage console and S3 API |
| Polaris API | value of `POLARIS_CLIENT_ID` | `POLARIS_CLIENT_SECRET` | Catalog bootstrap/API client, not a web login |
| PostgreSQL | value of `POSTGRES_USER` | `POSTGRES_PASSWORD` | Local metadata database |
| Qdrant API | no username | `QDRANT_API_KEY` | API authentication |

To display the exact seeded values for this checkout, run the following command
locally. Its output contains passwords, so do not paste it into chat, logs, or
issues:

```bash
grep -E '^(PSU_(ADMIN|ANALYST|VIEWER)_(USERNAME|PASSWORD)|NIFI_(USERNAME|PASSWORD)|RUSTFS_(ACCESS_KEY|SECRET_KEY)|POLARIS_CLIENT_(ID|SECRET)|POSTGRES_(USER|PASSWORD)|QDRANT_API_KEY)=' .env
```

The usernames shown above are the defaults from `.env.example`. If your `.env`
uses different username values, use those values instead.

## 5. Service URLs

| What to open | URL | What it is for |
|---|---|---|
| PSU control page | <http://localhost:8085> | Links to the main local interfaces |
| Superset | <http://localhost:8088> | SQL Lab, datasets, charts, dashboards, and user administration |
| Trino | <http://localhost:8086> | SQL engine UI and query status |
| NiFi | <https://localhost:8443/nifi> | Build ingestion flows; accept the local certificate warning |
| RustFS Console | <http://localhost:9001> | Inspect the `psu-lakehouse` object bucket |
| Qdrant Dashboard | <http://localhost:6333/dashboard> | Inspect vector collections |
| Polaris API | <http://localhost:8181> | REST API; there is no seeded management UI |
| Superset MCP | <http://localhost:5008/mcp> | Local MCP endpoint for an AI client |
| PostgreSQL | `127.0.0.1:5432` | Polaris and Superset metadata databases |

Trino uses host port 8086 because port 8080 is commonly occupied. Services
inside Compose still connect to `trino:8080`. Override the host port by setting
`TRINO_HOST_PORT` in `.env` and update any browser bookmarks accordingly.

## 6. First walkthrough

### 6.1 Explore the catalog with Superset

1. Open <http://localhost:8088>.
2. Sign in as `psu-admin` using `PSU_ADMIN_PASSWORD` from `.env`.
3. Open **SQL → SQL Lab**.
4. Select the database named **PSU Iceberg**.
5. Run:

```sql
SHOW SCHEMAS FROM polaris;
```

The initialized schemas are:

- `raw` — newly ingested, minimally processed data;
- `curated` — cleaned and standardized data;
- `published` — approved data products for broad consumption;
- `documents` — governed document and chunk metadata.

There are no seeded sample tables. After an ingestion flow creates tables, list
them with:

```sql
SHOW TABLES FROM polaris.raw;
```

### 6.2 Compare the seeded access roles

Sign out of Superset and repeat queries as `analyst` and `viewer`.

| Superset user | Trino group | Allowed data access |
|---|---|---|
| `psu-admin` | `psu_admin` | All catalogs and operations |
| `analyst` | `psu_analyst` | Read `curated` and `published` |
| `viewer` | `psu_viewer` | Read `published` only |
| `nifi` service identity | `psu_ingestion` | Write `raw`, `curated`, and `documents` |

Superset handles the local login, but Trino and OPA enforce the data boundary.
The username-to-group mapping is in
[`config/trino/groups.txt`](config/trino/groups.txt), and the authorization
rules are in [`config/opa/trino.rego`](config/opa/trino.rego).

### 6.3 Prepare a CSV ingestion

Copy a test CSV into the incoming folder:

```bash
cp /path/to/example.csv data/incoming/csv/
```

NiFi sees it at `/data/incoming/csv/example.csv`. Placing the file there does
not ingest it automatically; NiFi flows are intentionally not pre-seeded.

Open NiFi and build a flow using processors/controller services such as:

- `ListFile` and `FetchFile` to read incoming files;
- `CSVReader` to parse records;
- `RESTIcebergCatalog` for Polaris;
- `S3IcebergFileIOProvider` for RustFS;
- `ParquetIcebergWriter` and `PutIcebergRecord` for Iceberg output.

Database ingestion can use `QueryDatabaseTableRecord` with a JDBC connection
pool. Put required JDBC JAR files in `drivers/`; see
[`drivers/README.md`](drivers/README.md).

### 6.4 Inspect stored objects

Open the RustFS Console, sign in with `RUSTFS_ACCESS_KEY` and
`RUSTFS_SECRET_KEY`, and open the bucket named by `RUSTFS_BUCKET`. Iceberg data
files and metadata appear there after tables are written.

Do not edit or delete Iceberg metadata directly in RustFS. Use Iceberg-aware
tools through Polaris and Trino.

### 6.5 Documents and vectors

Place source documents under `data/incoming/documents`. NiFi can preserve the
originals in RustFS and send extracted chunks and embeddings to Qdrant.

Document extraction, chunking, embedding, and Qdrant collection flows are not
pre-seeded. Qdrant is a rebuildable search index; it must not be the only copy
of source text or governed metadata.

### 6.6 Connect an AI client to Superset MCP

Use this local MCP endpoint:

```text
http://localhost:5008/mcp
```

The local MCP service has authentication disabled and executes as the seeded
analyst identity. It is bound to `127.0.0.1`; never expose it directly to a
network. Review AI-generated SQL, charts, and dashboards before saving or
publishing them.

## 7. Add or change users

1. Sign in to Superset as `psu-admin`.
2. Open **Settings → Security → List Users**.
3. Create the user with the minimum required Superset role:
   `Admin`, `Alpha`, or `Gamma`.
4. Add the same username to the correct group in
   `config/trino/groups.txt`.
5. Wait up to five seconds for Trino to reload the group file.

After changing `config/opa/trino.rego`, validate and reload it:

```bash
docker compose run --rm opa check /policies/trino.rego
docker compose restart opa
```

Do not use a broad Superset role as a substitute for a Trino/OPA rule.

## 8. Everyday operations

Check status:

```bash
docker compose ps -a
```

Follow all logs or one service:

```bash
docker compose logs -f
docker compose logs -f trino
docker compose logs -f superset
```

Restart one service after changing its bind-mounted configuration:

```bash
docker compose restart opa
docker compose restart trino
```

Stop the stack while preserving data:

```bash
docker compose down
```

Start it again without rebuilding unchanged images:

```bash
docker compose up -d
```

Rebuild after changing `docker/superset/Dockerfile`:

```bash
docker compose up -d --build
```

## 9. Persistence and backup scope

State survives `docker compose down` because it is bind-mounted under
`runtime/`:

| Folder | Persistent state |
|---|---|
| `runtime/postgres` | Polaris and Superset metadata |
| `runtime/rustfs` | Iceberg objects and source documents |
| `runtime/trino` | Trino local state |
| `runtime/superset` | Superset home data |
| `runtime/qdrant` | Vector collections |
| `runtime/redis` | Superset cache |
| `runtime/nifi` | NiFi flows, content, state, and provenance |

Do not delete `runtime/` to fix a startup problem. That is a destructive reset
of local metadata, flows, tables, and indexes. Back up PostgreSQL and RustFS
together to preserve a consistent Iceberg catalog and object store.

## 10. Troubleshooting

### A setup container exits non-zero

```bash
docker compose logs --tail=200 polaris-bootstrap polaris-setup superset-init
docker compose ps -a
```

Successful one-time containers should show `Exited (0)`. The bootstrap scripts
are safe to rerun with:

```bash
docker compose up -d
```

### A long-running service is unhealthy

```bash
docker compose logs --tail=200 trino
docker compose logs --tail=200 superset
docker compose logs --tail=200 superset-mcp
```

### A host port is already in use

Find the listener on macOS or Linux:

```bash
lsof -nP -iTCP:8086 -sTCP:LISTEN
```

For Trino, choose another free host port in `.env`:

```dotenv
TRINO_HOST_PORT=8087
```

Then recreate Trino:

```bash
docker compose up -d --force-recreate trino
```

### NiFi shows a certificate warning or HTTP 400

Use exactly <https://localhost:8443/nifi>, not the container IP. The local
self-signed certificate causes an expected browser warning.

## 11. Local-MVP security boundaries

- This is a single-host learning/MVP deployment, not a production cluster.
- Superset users are local test users; PSU OAuth2 SSO is not configured.
- Superset MCP authentication is disabled and must remain localhost-only.
- Default/example `.env` values must never protect real data.
- TLS between internal services, HA, automated backup, and disaster recovery
  are not configured.
- Never commit `.env` or paste its contents into tickets, chat, or logs.

For more operational detail, see [`docs/RUNBOOK.md`](docs/RUNBOOK.md). For the
component boundaries and data flow, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
