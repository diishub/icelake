package trino

import rego.v1

viewer_context := {"context": {"identity": {"user": "viewer", "groups": ["psu_viewer"]}}}
analyst_context := {"context": {"identity": {"user": "analyst", "groups": ["psu_analyst"]}}}
ingestion_context := {"context": {"identity": {"user": "nifi", "groups": ["psu_ingestion"]}}}

test_viewer_can_start_query if {
  allow with input as object.union(viewer_context, {"action": {"operation": "ExecuteQuery", "resource": {}}})
}

test_viewer_can_read_published if {
  allow with input as object.union(viewer_context, {"action": {
    "operation": "SelectFromColumns",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report"}},
  }})
}

test_viewer_can_read_information_schema if {
  allow with input as object.union(viewer_context, {"action": {
    "operation": "SelectFromColumns",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "information_schema", "tableName": "schemata"}},
  }})
}

test_viewer_cannot_read_curated if {
  not allow with input as object.union(viewer_context, {"action": {
    "operation": "SelectFromColumns",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "curated", "tableName": "internal"}},
  }})
}

test_analyst_can_read_curated if {
  allow with input as object.union(analyst_context, {"action": {
    "operation": "SelectFromColumns",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "curated", "tableName": "model"}},
  }})
}

test_analyst_cannot_read_raw if {
  not allow with input as object.union(analyst_context, {"action": {
    "operation": "SelectFromColumns",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "source"}},
  }})
}

test_viewer_cannot_execute_procedure if {
  not allow with input as object.union(viewer_context, {"action": {"operation": "ExecuteProcedure", "resource": {}}})
}

test_viewer_cannot_create_table if {
  not allow with input as object.union(viewer_context, {"action": {
    "operation": "CreateTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "bad"}},
  }})
}

test_ingestion_can_write_raw if {
  allow with input as object.union(ingestion_context, {"action": {
    "operation": "CreateTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "source"}},
  }})
}

test_ingestion_cannot_write_published if {
  not allow with input as object.union(ingestion_context, {"action": {
    "operation": "CreateTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report"}},
  }})
}

test_superset_can_impersonate_dev_user if {
  allow with input as {
    "context": {"identity": {"user": "superset", "groups": ["psu_analyst"]}},
    "action": {"operation": "ImpersonateUser", "resource": {"user": {"user": "viewer"}}},
  }
}

test_analyst_cannot_impersonate if {
  not allow with input as object.union(analyst_context, {"action": {
    "operation": "ImpersonateUser",
    "resource": {"user": {"user": "viewer"}},
  }})
}

test_unknown_user_is_denied if {
  not allow with input as {
    "context": {"identity": {"user": "unknown", "groups": []}},
    "action": {"operation": "ExecuteQuery", "resource": {}},
  }
}
