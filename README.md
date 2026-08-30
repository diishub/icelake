# PSU Open Lakehouse

PSU Open Lakehouse is a local, open-source data platform for learning and
testing governed ingestion, Apache Iceberg storage, SQL analytics, dashboards,
and AI-assisted data access. The repository keeps the upstream tools intact and
adds a thin, Thai-first **PSU Data Hub** entry page so ordinary users start from
their task instead of choosing infrastructure products. The portal is a
navigation and guidance layer; Superset, Trino, and OPA still enforce the real
login and data permissions.

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
chmod 600 .env
```

Replace every `change-me` value before starting the stack. The three Superset
development personas can be reconciled after a password or role change with the
seed command below. Changing infrastructure credentials in `.env` is **not** a
rotation procedure for an already initialized PostgreSQL, Polaris, RustFS, or
NiFi service.

## 3. Start the complete stack

The first start pulls several large images and builds the Superset image, so it
can take tens of minutes:

```bash
./scripts/validate-dev-env.sh
docker compose up -d --build
```

Watch the one-time initialization services:

```bash
docker compose logs -f polaris-bootstrap polaris-setup dev-identity-setup superset-init
```

In another terminal, inspect all containers:

```bash
docker compose ps -a
```

The stack is ready when:

- `polaris-bootstrap`, `polaris-setup`, `bucket-setup`, `dev-identity-setup`,
  and `superset-init` show `Exited (0)`;
- Polaris, PostgreSQL, Redis, Trino, Superset, and Superset MCP are healthy;
- the remaining long-running services show `Up`.

`Exited (0)` is the expected successful state for those one-time setup
containers. It does not mean the stack stopped.

Open the beginner-facing entry page after startup:

<http://localhost:8085>

Reconcile the complete local development identity configuration and wait for
the acceptance checks:

```bash
./scripts/seed-dev-accounts.sh
./scripts/verify-dev-accounts.sh
```

The handoff for the next engineer, including the exact operating boundary and
next-work checklist, is in
[`docs/ENGINEER_HANDOFF_TH.md`](docs/ENGINEER_HANDOFF_TH.md).

## 4. Development identity model

Passwords are not hard-coded in this README. The source of truth is your local
`.env` file so credentials are not accidentally committed.

| Surface | Identity | Credential source | Purpose |
|---|---|---|---|
| Superset | `psu-admin` by default | `PSU_ADMIN_PASSWORD` | Full local administrator |
| Superset | `analyst` by default | `PSU_ANALYST_PASSWORD` | Read `curated` and `published` |
| Superset | `viewer` by default | `PSU_VIEWER_PASSWORD` | Read `published` only |
| NiFi | `psu-admin` by default | `NIFI_PASSWORD` | NiFi single-user administrator |
| Trino | `nifi` by default | No password store; `TRINO_INGESTION_USERNAME` is an asserted logical identity | Dev-only table operations in `raw`, `curated`, and `documents` for clients routed through Trino |
| RustFS | value of `RUSTFS_ACCESS_KEY` | `RUSTFS_SECRET_KEY` | Object-storage console and S3 API |
| Polaris API | value of `POLARIS_CLIENT_ID` | `POLARIS_CLIENT_SECRET` | Catalog bootstrap/API client, not a web login |
| PostgreSQL | value of `POSTGRES_USER` | `POSTGRES_PASSWORD` | Local metadata database |
| Qdrant API | no username | `QDRANT_API_KEY` | API authentication |
| Superset MCP | no login in this phase | Deliberately unauthenticated, loopback-only | Executes as the analyst dev persona |

The usernames shown above are the defaults from `.env.example`. If your `.env`
uses different username values, use those values instead. Do not print or paste
the contents of `.env`; the seed and verification scripts report pass/fail
without printing credentials.

## 5. Entry points

| What to open | URL | What it is for |
|---|---|---|
| PSU Data Hub | <http://localhost:8085> | Recommended starting point for every pilot user |
| PSU Reports | <http://localhost:8088/dashboard/list/> | Authenticated reports; analysts can continue to SQL Lab |
| Trino | <http://localhost:8086> | Operator-only query status on the server host |
| NiFi | <https://localhost:8443/nifi> | Operator-only ingestion workbench on the server host |
| RustFS Console | <http://localhost:9001> | Operator-only object storage console; never edit Iceberg metadata directly |
| Qdrant Dashboard | <http://localhost:6333/dashboard> | Operator-only vector-index inspection |
| Polaris API | <http://localhost:8181> | Internal catalog REST API; not a user interface |
| Superset MCP | <http://localhost:5008/mcp> | Loopback-only endpoint for a reviewed AI client |
| PostgreSQL | `127.0.0.1:5432` | Internal Polaris and Superset metadata databases |

The portal intentionally does not advertise the operator tools to a normal
network user. When opened on `localhost`, a platform-team section appears at
the bottom for local operations. That visibility is only navigation; each
upstream service remains responsible for authentication and authorization.

Trino uses host port 8086 because port 8080 is commonly occupied. Services
inside Compose still connect to `trino:8080`. Override the host port by setting
`TRINO_HOST_PORT` in `.env` and update any browser bookmarks accordingly.

## 6. First walkthrough

### 6.1 Complete the beginner path

1. Open <http://localhost:8085>.
2. Choose the role closest to today's task. This only changes guidance; it does
   not change data access.
3. Open the clearly marked fictional report to learn the expected result.
4. Select **เข้าสู่ระบบรายงานจริง** and sign in with the named pilot account
   supplied by an administrator.
5. If the report list is empty, return to the portal and use the request
   template. Do not explore admin menus to look for missing data.

The initial checkout has no seeded sample tables or published dashboards. This
empty state is shown honestly in the portal and must be changed in
`portal/config.js` only after a real published report is acceptance-tested.

For a short Thai user handout, see
[`docs/USER_GUIDE_TH.md`](docs/USER_GUIDE_TH.md).
The five-day path from this empty, safe portal to one real report is in
[`docs/MVP_NEXT_WEEK_TH.md`](docs/MVP_NEXT_WEEK_TH.md).

### 6.2 Explore the catalog with Superset (platform team)

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

### 6.3 Compare the seeded access roles

Sign out of Superset and repeat queries as `analyst` and `viewer`.

| Superset user | Trino group | Allowed data access |
|---|---|---|
| `psu-admin` | `psu_admin` | All catalogs and operations |
| `analyst` | `psu_analyst` | Read `curated` and `published` |
| `viewer` | `psu_viewer` | Read `published` only |
| value of `TRINO_INGESTION_USERNAME` | `psu_ingestion` | Dev-only table operations in `raw`, `curated`, and `documents` through Trino |

Superset handles the local login, but Trino and OPA enforce the data boundary.
The username-to-group mapping is generated by
[`config/trino/render-groups.sh`](config/trino/render-groups.sh) from `.env` into
the ignored runtime directory. Authorization rules and tests are in
[`config/opa/trino.rego`](config/opa/trino.rego) and
[`config/opa/trino_test.rego`](config/opa/trino_test.rego).

### 6.4 Prepare a CSV ingestion

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

### 6.5 Inspect stored objects

Open the RustFS Console, sign in with `RUSTFS_ACCESS_KEY` and
`RUSTFS_SECRET_KEY`, and open the bucket named by `RUSTFS_BUCKET`. Iceberg data
files and metadata appear there after tables are written.

Do not edit or delete Iceberg metadata directly in RustFS. Use Iceberg-aware
tools through Polaris and Trino.

### 6.6 Documents and vectors

Place source documents under `data/incoming/documents`. NiFi can preserve the
originals in RustFS and send extracted chunks and embeddings to Qdrant.

Document extraction, chunking, embedding, and Qdrant collection flows are not
pre-seeded. Qdrant is a rebuildable search index; it must not be the only copy
of source text or governed metadata.

### 6.7 Connect an AI client to Superset MCP

Use this local MCP endpoint:

```text
http://localhost:5008/mcp
```

The local MCP service has authentication disabled and executes as the seeded
analyst identity. It is bound to `127.0.0.1`; never expose it directly to a
network. Review AI-generated SQL, charts, and dashboards before saving or
publishing them.

## 7. Add or change users

The current automation owns only the three shared **development personas** in
`.env`. Change their usernames/passwords there, then run both account scripts.
If a username changes, the new account is reconciled but the old Superset
account is not deleted automatically; verify access and deactivate the obsolete
account explicitly in **Settings → Security → List Users**.

Do not hand the shared personas to a real pilot group. Before a pilot, provision
10–20 named local Superset accounts and a non-committed Trino group-membership
source, or implement PSU SSO in a later phase. The current generated runtime
group file must not be edited by hand because the next seed run replaces it.

After changing `config/opa/trino.rego`, validate and reload it:

```bash
docker compose run --rm opa check /policies/trino.rego
docker compose run --rm opa test /policies --verbose
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

For a routine stop, keep the containers so an unexported NiFi flow definition
is not discarded with the NiFi container:

```bash
docker compose stop
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

The state listed below is bind-mounted under `runtime/`. This does **not** mean
every service can safely survive container deletion:

| Folder | Persistent state |
|---|---|
| `runtime/postgres` | Polaris and Superset metadata |
| `runtime/rustfs` | Iceberg objects and source documents |
| `runtime/trino` | Trino local state |
| `runtime/superset` | Superset home data |
| `runtime/qdrant` | Vector collections |
| `runtime/redis` | Superset cache |
| `runtime/nifi` | NiFi repositories, state, and logs; the flow definition is not yet guaranteed by the current mounts |

The current NiFi mounts do not guarantee its flow definition. Export/version a
flow before `docker compose down`, `--force-recreate`, image replacement, or
host migration. Use `docker compose stop` for the normal stop path. Do not
delete `runtime/` to fix a startup problem; that is a destructive reset of
local metadata, repositories, tables, and indexes. Back up PostgreSQL and
RustFS together to preserve a consistent Iceberg catalog and object store.

## 10. Troubleshooting

### A setup container exits non-zero

```bash
docker compose logs --tail=200 polaris-bootstrap polaris-setup dev-identity-setup superset-init
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
- The portal is not an authentication gateway. Portal, Superset, query, storage,
  and operator host ports are loopback-only in this development phase. Use
  synthetic data; do not change them to public bindings without an approved
  TLS/authentication perimeter.
- The RustFS API and console are loopback-only. Keep object storage behind the
  platform boundary; do not republish ports 9000/9001 to user networks.
- Superset users are local test users; PSU OAuth2 SSO is not configured.
- Superset MCP authentication is disabled and must remain localhost-only.
- Default/example `.env` values must never protect real data.
- TLS between internal services, HA, automated backup, and disaster recovery
  are not configured.
- Never commit `.env` or paste its contents into tickets, chat, or logs.

For more operational detail, see [`docs/RUNBOOK.md`](docs/RUNBOOK.md). For the
component boundaries and data flow, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
