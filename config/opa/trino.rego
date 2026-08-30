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
is_reader if is_analyst
is_reader if is_viewer

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

# Superset is the only configured impersonating client in this dev stack. It
# turns the authenticated local BI username into the Trino identity that the
# group provider and table rules evaluate. This is replaced by SSO claims in a
# later phase, not broadened to other local users.
allow if {
  user == "superset"
  operation == "ImpersonateUser"
}
