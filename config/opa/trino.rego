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

is_write_operation if regex.match(
  "^(Create|Drop|Rename|Set|Insert|Delete|Update|Truncate|Grant|Revoke|Execute|Kill|Add|Alter)",
  operation,
)

is_select if operation == "SelectFromColumns"

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

# Read-only discovery operations are needed by Superset and Trino clients. Table
# reads are handled by the stricter SelectFromColumns rules above.
allow if {
  is_reader
  not is_write_operation
  not is_select
}
