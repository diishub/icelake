package trino

import rego.v1

default allow := false

user := input.context.identity.user
groups := input.context.identity.groups
operation := input.action.operation

is_admin if "psu_admin" in groups
is_ingestion if "psu_ingestion" in groups
is_analyst if "psu_analyst" in groups
is_viewer if "psu_viewer" in groups
is_viewer_exec if "psu_viewer_exec" in groups
is_reader if is_analyst
is_reader if is_viewer

# Non-executive viewers are scoped to their org unit(s) via psu_viewer_org_<unit>
# groups rendered by config/trino/render-groups.sh from PSU_VIEWER_<n>_ORG_UNIT.
viewer_org_units := {ou |
  some g in groups
  startswith(g, "psu_viewer_org_")
  ou := trim_prefix(g, "psu_viewer_org_")
}

table := input.action.resource.table

is_select if operation == "SelectFromColumns"

# Query execution and metadata discovery are separate OPA checks from table
# reads. Keep this allow-list explicit so reader personas can start queries
# without accidentally gaining procedures, DDL, DML, or impersonation.
read_control_operations := {
  "ExecuteQuery",
  "AccessCatalog",
  "FilterCatalogs",
  "FilterSchemas",
  "FilterTables",
  "FilterColumns",
  "FilterFunctions",
  "ShowSchemas",
  "ShowTables",
  "ShowColumns",
  "ShowCreateSchema",
  "ShowCreateTable",
  "ShowFunctions",
  "ShowCreateFunction",
  "ExecuteFunction",
  "ReadSystemInformation",
  "ViewQueryOwnedBy",
  "FilterViewQueryOwnedBy",
}

allow if is_admin

allow if {
  is_ingestion
  table.catalogName == "polaris"
  table.schemaName in {"raw", "curated", "documents"}
}

# Ingestion also gets a Hive-catalog staging area (config/trino/catalog/hive.properties)
# used to bridge file-based sources into Iceberg via Trino SQL, since NiFi's
# own Iceberg processors cannot write to this stack's Polaris. No operation
# restriction here, matching the polaris rule above -- ingestion needs
# CREATE/DROP/INSERT/SELECT on its own staging tables.
allow if {
  is_ingestion
  table.catalogName == "hive"
  table.schemaName == "raw_staging"
}

# SHOW SCHEMAS/TABLES against hive go through information_schema reads, same
# as the polaris pattern above -- needed for discovery, not just direct DDL.
allow if {
  is_ingestion
  is_select
  table.catalogName == "hive"
  table.schemaName == "information_schema"
}

allow if {
  is_analyst
  is_select
  table.catalogName == "polaris"
  table.schemaName in {"curated", "published"}
}

allow if {
  is_viewer
  is_select
  table.catalogName == "polaris"
  table.schemaName == "published"
}

# Analysts additionally get row-level write access on curated and published —
# schema/table DDL (CreateTable, DropTable, ...) stays admin/ingestion-only.
allow if {
  is_analyst
  table.catalogName == "polaris"
  table.schemaName in {"curated", "published"}
  operation in {"InsertIntoTable", "UpdateTableColumns", "DeleteFromTable"}
}

# Trino implements SHOW/DESCRIBE through information_schema reads. Readers need
# this metadata path for Superset dataset discovery; data-table reads remain
# constrained by the curated/published rules above.
allow if {
  is_reader
  is_select
  table.catalogName == "polaris"
  table.schemaName == "information_schema"
}

# Query startup and read-only discovery are needed by Superset and Trino
# clients. Table reads are still handled by the stricter SelectFromColumns
# rules above.
allow if {
  is_reader
  operation in read_control_operations
}

allow if {
  is_ingestion
  operation in read_control_operations
}

# CreateSchema is a tableless gate -- its resource has a `schema` field, not
# `table`, so none of the per-table rules above ever see it. Must be granted
# separately or Trino denies it before those rules get a chance to match.
# Scoped to the catalogs ingestion legitimately has per-table access to.
ingestion_catalogs := {"polaris", "hive"}

allow if {
  is_ingestion
  operation == "CreateSchema"
  input.action.resource.schema.catalogName in ingestion_catalogs
}

# Superset is the only configured impersonating client in this dev stack. It
# turns the authenticated local BI username into the Trino identity that the
# group provider and table rules evaluate. This is replaced by SSO claims in a
# later phase, not broadened to other local users.
allow if {
  user == "superset"
  operation == "ImpersonateUser"
}

# Row-level filtering for non-executive viewers, opt-in per table via
# data/trino/org_scoped_tables.json (config/opa/org_scoped_tables.json). A
# table only gets filtered once its owner lists it there AND it actually has
# an org_unit column — an un-listed table is unaffected, same as today.
rowFilters contains {"expression": sprintf("org_unit = '%s'", [ou])} if {
  is_viewer
  not is_viewer_exec
  table.schemaName == "published"
  table.tableName in data.org_scoped_tables
  some ou in viewer_org_units
}