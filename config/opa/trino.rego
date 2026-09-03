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

# ---------------------------------------------------------------------------
# Table maintenance
# ---------------------------------------------------------------------------
# Compaction, snapshot expiry and orphan-file removal run as their own
# identity, separate from ingestion. That separation is the point: this
# identity reshapes and deletes files but is never granted SelectFromColumns,
# so a maintenance job cannot read a single row of the data it maintains.
#
# It matters for more than tidiness here. Dropping an Iceberg table in this
# stack does not delete its data files, so removing personal data on request
# is only actually complete once orphan-file removal has run.
is_maintenance if "psu_maintenance" in groups

# Trino has used more than one operation name for ALTER TABLE ... EXECUTE
# across versions; both are listed so an upgrade does not silently start
# denying maintenance.
maintenance_operations := {
  "ExecuteTableProcedure",
  "AlterTableExecute",
}

allow if {
  is_maintenance
  operation in maintenance_operations
  table.catalogName == "polaris"
  table.schemaName in {"raw", "curated", "published"}
}

# Maintenance still has to be able to start a query and list what exists.
allow if {
  is_maintenance
  operation in read_control_operations
}

# Reading the table list is metadata, not data: information_schema stays
# available so a maintenance run can discover the tables it was asked about.
allow if {
  is_maintenance
  is_select
  table.catalogName == "polaris"
  table.schemaName == "information_schema"
}

# Trino authorises ALTER TABLE ... EXECUTE by asking a SelectFromColumns
# question with an empty column list, not only the procedure question above
# (verified live against Trino 483: the denial was "Cannot select from columns
# [] in table"). Allowing only the empty-column form keeps the property that
# matters -- a request naming any column is a real read and stays denied, so
# maintenance still cannot see a single value.
maintenance_schemas := {"raw", "curated", "published"}

allow if {
  is_maintenance
  is_select
  table.catalogName == "polaris"
  table.schemaName in maintenance_schemas
  count(object.get(table, "columns", [])) == 0
}

# Rewriting data files is what compaction is: the procedure shows up as
# inserts and deletes against the same table.
allow if {
  is_maintenance
  operation in {"InsertIntoTable", "DeleteFromTable"}
  table.catalogName == "polaris"
  table.schemaName in maintenance_schemas
}

# The retention floor exists so a mistyped threshold cannot delete files a
# running query still needs. Lowering it is a deliberate, authorised act, and
# it is scoped: maintenance may set only these two properties, only on the
# lakehouse catalog, and nothing else gains the ability at all.
allow if {
  is_maintenance
  operation == "SetCatalogSessionProperty"
  input.action.resource.catalogSessionProperty.catalogName == "polaris"
  input.action.resource.catalogSessionProperty.propertyName in {
    "expire_snapshots_min_retention",
    "remove_orphan_files_min_retention",
  }
}

# ---------------------------------------------------------------------------
# The ingestion control plane, read through Trino
# ---------------------------------------------------------------------------
# Operations dashboards read run history through the same engine and the same
# policy as everything else, rather than through a second connection straight
# to PostgreSQL that this policy would never see.
#
# Analysts and admins can read it; viewers cannot. Run history is operational
# detail about the platform, not a published data product, and it names source
# systems and tables a report reader has no reason to see. The catalog itself
# is read-only at the database level (config/platform/002-roles.sql), so this
# rule cannot be the only thing standing between a dashboard and a write.
allow if {
  is_analyst
  is_select
  table.catalogName == "platform"
  table.schemaName in {"ingest", "information_schema"}
}
