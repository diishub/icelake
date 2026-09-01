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
| Superset | `analyst` by default | `PSU_ANALYST_PASSWORD` | Read + write (`INSERT`/`UPDATE`/`DELETE`) on `curated` and `published`; author dashboards |
| Superset | one account per `PSU_VIEWER_<n>_USERNAME` (`viewer`/`viewer-eng`/`viewer-med` by default) | `PSU_VIEWER_<n>_PASSWORD` | Read `published` only; each account's `PSU_VIEWER_<n>_ORG_UNIT` further narrows which rows it sees on tables opted into row filtering — see §4.1 |
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

### 4.1 Viewer org-unit tiers

`PSU_VIEWER_COUNT` in `.env` controls how many viewer accounts exist (numbered
`PSU_VIEWER_1_*` .. `PSU_VIEWER_<PSU_VIEWER_COUNT>_*`, up to 10 — this is a
dev-only scheme; see §7 for the pilot-scale alternative). Each account has its
own `_USERNAME`, `_PASSWORD`, and `_ORG_UNIT`:

- `PSU_VIEWER_<n>_ORG_UNIT=*` — an **executive/head** tier: sees every org
  unit's rows, unfiltered, still only within `published`.
- Any other value (e.g. `eng`, `med`) — a **standard** tier: on any table
  listed in [`config/opa/org_scoped_tables.json`](config/opa/org_scoped_tables.json),
  sees only rows where its `org_unit` column matches.

Row filtering is enforced by Trino's OPA row-filter integration
(`opa.policy.row-filters-uri` in
[`config/trino/access-control.properties`](config/trino/access-control.properties),
policy in [`config/opa/trino.rego`](config/opa/trino.rego)), so it applies to
every client that queries through Trino, not just Superset dashboards.

**A table is only filtered once its owner opts it in.** Add the table name to
`config/opa/org_scoped_tables.json` and give it an `org_unit` column — a table
not listed there is unaffected (same as before this feature existed). Listing
a table that has no `org_unit` column will make every query against it fail,
not silently return unfiltered rows — add the column first.

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

Every port above is `127.0.0.1`-only (§11). Reach them from off-host through
an SSH tunnel:

```bash
ssh -L 8085:127.0.0.1:8085 -L 8088:127.0.0.1:8088 <user>@<host>
```

Add one `-L` per port needed, then open `http://localhost:<port>` locally.
A public-facing reverse proxy was evaluated and deliberately dropped for
this deployment (kept every service loopback-only/SSH-tunnel-only instead)
— see the git history around 2026-08-31 if that's ever revisited.

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

Sign out of Superset and repeat queries as `analyst` and each viewer account.

| Superset user | Trino group(s) | Allowed data access |
|---|---|---|
| `psu-admin` | `psu_admin` | All catalogs and operations |
| `analyst` | `psu_analyst` | Read/write (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) on `curated` and `published` — no schema DDL |
| viewer with `_ORG_UNIT=*` (`viewer` by default) | `psu_viewer`, `psu_viewer_exec` | Read all of `published`, unfiltered |
| viewer with `_ORG_UNIT=eng`/`med`/... | `psu_viewer`, `psu_viewer_org_<unit>` | Read `published`, row-filtered to its org unit on any table listed in `config/opa/org_scoped_tables.json` |
| value of `TRINO_INGESTION_USERNAME` | `psu_ingestion` | Dev-only table operations in `raw`, `curated`, and `documents` through Trino |

Superset handles the local login, but Trino and OPA enforce the data boundary.
The username-to-group mapping is generated by
[`config/trino/render-groups.sh`](config/trino/render-groups.sh) from `.env` into
the ignored runtime directory. Authorization rules and tests are in
[`config/opa/trino.rego`](config/opa/trino.rego) and
[`config/opa/trino_test.rego`](config/opa/trino_test.rego).

### 6.4 Prepare an ingestion flow

Copy a test file into an incoming folder (`data/incoming/csv/`,
`data/incoming/files/`, or `data/incoming/documents/`):

```bash
cp /path/to/example.csv data/incoming/csv/
```

NiFi sees it at `/data/incoming/csv/example.csv`. Placing the file there does
not ingest it automatically; NiFi flows are intentionally not pre-seeded —
open NiFi (`https://localhost:8443/nifi`, through an SSH tunnel per §5) and
build one.

**Do not use NiFi's native Iceberg processors** (`RESTIcebergCatalog`,
`PutIcebergRecord`, `S3IcebergFileIOProvider`) **against this stack's
Polaris** — verified broken two independent ways on NiFi 2.10.0: the
`RESTIcebergCatalog` controller service can't attach the `Polaris-Realm`
header Polaris requires, and even with that requirement disabled,
`PutIcebergRecord` throws `UnsupportedOperationException: Returning response
headers is not supported` on every write, regardless of credentials.

The proven working pattern instead routes through **Trino SQL** using a
second, file-metastore-backed Trino catalog
([`config/trino/catalog/hive.properties`](config/trino/catalog/hive.properties))
as a staging area:

1. Land the raw file in RustFS via `PutS3Object` (any format — this is a
   plain archival copy, not a parse step).
2. For structured sources meant for Iceberg, stage the data as a file in
   RustFS too (the same CSV, or a `QueryDatabaseTableRecord` result written
   with a `CSVRecordSetWriter`), then use `ExecuteGroovyScript` to drive
   Trino's `/v1/statement` REST API (`X-Trino-User: nifi`) and: create a
   one-off external table in `hive.raw_staging` pointing at that one staged
   file, `INSERT INTO polaris.raw."<table>" SELECT * FROM` it, then `DROP
   TABLE` the staging pointer (metadata only — the underlying file in RustFS
   is untouched, so this is safe to make idempotent per ingested file/batch).

This is how both a universal any-format file-archive flow and an incremental
`QueryDatabaseTableRecord`-based database ingestion flow (`DBCPConnectionPool`
+ JDBC driver in `drivers/`, see [`drivers/README.md`](drivers/README.md))
were built and verified end-to-end against a synthetic PostgreSQL source
during development. Neither flow definition is committed to this repo (same
"not pre-seeded" policy as above) — rebuild them the same way if lost.

**Ingesting from a real external source with PDPA-sensitive tables**: if the
source database has its own column-level classification metadata (a
`meta.db_table`/`meta.db_column` style registry with a `classification`/
`secret_level` field — PSU's own warehouses commonly do), build the ingestion
as **metadata-driven** rather than a per-table `QueryDatabaseTableRecord`:
`QueryDatabaseTableRecord` doesn't accept an incoming connection in this NiFi
version (`INPUT_FORBIDDEN`, verified), so a single `ExecuteGroovyScript` opens
its own JDBC connection instead (`java.sql.DriverManager`, connection details
passed as container environment variables — see the `PSU_SOURCE_DB_*` vars in
`.env.example` and `nifi`'s environment in `compose.yaml`), queries the
source's own table/column registry for the target schema, and **excludes any
column flagged sensitive before ever selecting it** — never `SELECT *` against
a table that hasn't been checked this way. A table with zero registered
"safe" columns is skipped entirely (fail closed), not defaulted to
"select everything." This was built and verified against a real 700+ table
PSU warehouse, piloted against one reference-data schema with zero flagged
columns before considering any schema with real personal data. Confirm the
lawful basis and retention period for anything beyond reference/lookup data
before extending this to a schema with personal data — this repo doesn't
decide that for you.

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

The current automation owns only the shared **development personas** in
`.env`: one `psu-admin`, one `analyst`, and `PSU_VIEWER_COUNT` viewer accounts
(each with its own `_USERNAME`/`_PASSWORD`/`_ORG_UNIT`, up to 10 slots — see
§4.1). Change them there, then run both account scripts. If a username
changes, the new account is reconciled but the old Superset account is not
deleted automatically; verify access and deactivate the obsolete account
explicitly in **Settings → Security → List Users**.

To add another org-unit viewer: pick the next unused `PSU_VIEWER_<n>_*` slot,
set its username/password/org unit in `.env`, raise `PSU_VIEWER_COUNT` if
needed, then rerun `./scripts/seed-dev-accounts.sh` and
`./scripts/verify-dev-accounts.sh`.

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
