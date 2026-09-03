package trino

import rego.v1

viewer_context := {"context": {"identity": {"user": "viewer", "groups": ["psu_viewer"]}}}
viewer_exec_context := {"context": {"identity": {"user": "exec-viewer", "groups": ["psu_viewer", "psu_viewer_exec"]}}}
viewer_eng_context := {"context": {"identity": {"user": "viewer-eng", "groups": ["psu_viewer", "psu_viewer_org_eng"]}}}
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

test_analyst_can_insert_curated if {
  allow with input as object.union(analyst_context, {"action": {
    "operation": "InsertIntoTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "curated", "tableName": "model"}},
  }})
}

test_analyst_can_update_published if {
  allow with input as object.union(analyst_context, {"action": {
    "operation": "UpdateTableColumns",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report", "columns": ["value"]}},
  }})
}

test_analyst_can_delete_curated if {
  allow with input as object.union(analyst_context, {"action": {
    "operation": "DeleteFromTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "curated", "tableName": "model"}},
  }})
}

test_analyst_cannot_insert_raw if {
  not allow with input as object.union(analyst_context, {"action": {
    "operation": "InsertIntoTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "source"}},
  }})
}

test_viewer_cannot_insert_published if {
  not allow with input as object.union(viewer_context, {"action": {
    "operation": "InsertIntoTable",
    "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report"}},
  }})
}

test_viewer_org_eng_row_filter_on_scoped_table if {
  rowFilters == {{"expression": "org_unit = 'eng'"}}
    with input as object.union(viewer_eng_context, {"action": {
      "operation": "GetRowFilters",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report"}},
    }})
    with data.org_scoped_tables as ["report"]
}

test_viewer_exec_no_row_filter_on_scoped_table if {
  count(rowFilters) == 0
    with input as object.union(viewer_exec_context, {"action": {
      "operation": "GetRowFilters",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report"}},
    }})
    with data.org_scoped_tables as ["report"]
}

test_viewer_no_org_group_no_row_filter if {
  count(rowFilters) == 0
    with input as object.union(viewer_context, {"action": {
      "operation": "GetRowFilters",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "report"}},
    }})
    with data.org_scoped_tables as ["report"]
}

test_viewer_org_eng_no_row_filter_on_unscoped_table if {
  count(rowFilters) == 0
    with input as object.union(viewer_eng_context, {"action": {
      "operation": "GetRowFilters",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "published", "tableName": "unlisted"}},
    }})
    with data.org_scoped_tables as ["report"]
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

test_ingestion_can_read_hive_information_schema if {
  allow with input as object.union(ingestion_context, {"action": {
    "operation": "SelectFromColumns",
    "resource": {"table": {"catalogName": "hive", "schemaName": "information_schema", "tableName": "schemata"}},
  }})
}

test_ingestion_can_write_hive_staging if {
  allow with input as object.union(ingestion_context, {"action": {
    "operation": "CreateTable",
    "resource": {"table": {"catalogName": "hive", "schemaName": "raw_staging", "tableName": "stage_1"}},
  }})
}

test_ingestion_can_create_schema_on_hive if {
  allow with input as object.union(ingestion_context, {"action": {
    "operation": "CreateSchema",
    "resource": {"schema": {"catalogName": "hive", "schemaName": "raw_staging"}},
  }})
}

test_analyst_cannot_create_schema_on_hive if {
  not allow with input as object.union(analyst_context, {"action": {
    "operation": "CreateSchema",
    "resource": {"schema": {"catalogName": "hive", "schemaName": "raw_staging"}},
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

test_maintenance_can_run_table_procedure if {
  allow with input as {
    "action": {
      "operation": "ExecuteTableProcedure",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "sim_hr_employee"}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_maintenance_cannot_read_rows if {
  not allow with input as {
    "action": {
      "operation": "SelectFromColumns",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "sim_hr_employee", "columns": ["employee_id", "department_id"]}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_maintenance_cannot_run_procedure_on_another_catalog if {
  not allow with input as {
    "action": {
      "operation": "ExecuteTableProcedure",
      "resource": {"table": {"catalogName": "hive", "schemaName": "raw_staging", "tableName": "stg_x"}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_ingestion_cannot_run_table_procedure if {
  not allow with input as {
    "action": {
      "operation": "ExecuteTableProcedure",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "sim_hr_employee"}},
    },
    "context": {"identity": {"user": "nifi", "groups": ["psu_ingestion_only_procedures"]}},
  }
}

test_maintenance_may_pass_the_empty_column_check if {
  allow with input as {
    "action": {
      "operation": "SelectFromColumns",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "sim_hr_employee", "columns": []}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_maintenance_cannot_read_a_named_column if {
  not allow with input as {
    "action": {
      "operation": "SelectFromColumns",
      "resource": {"table": {"catalogName": "polaris", "schemaName": "raw", "tableName": "sim_hr_employee", "columns": ["employee_id"]}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_maintenance_may_lower_the_retention_floor if {
  allow with input as {
    "action": {
      "operation": "SetCatalogSessionProperty",
      "resource": {"catalogSessionProperty": {"catalogName": "polaris", "propertyName": "remove_orphan_files_min_retention"}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_maintenance_cannot_set_any_other_session_property if {
  not allow with input as {
    "action": {
      "operation": "SetCatalogSessionProperty",
      "resource": {"catalogSessionProperty": {"catalogName": "polaris", "propertyName": "projection_pushdown_enabled"}},
    },
    "context": {"identity": {"user": "maintenance", "groups": ["psu_maintenance"]}},
  }
}

test_ingestion_cannot_lower_the_retention_floor if {
  not allow with input as {
    "action": {
      "operation": "SetCatalogSessionProperty",
      "resource": {"catalogSessionProperty": {"catalogName": "polaris", "propertyName": "remove_orphan_files_min_retention"}},
    },
    "context": {"identity": {"user": "nifi", "groups": ["psu_ingestion"]}},
  }
}

test_analyst_can_read_the_control_plane if {
  allow with input as {
    "action": {
      "operation": "SelectFromColumns",
      "resource": {"table": {"catalogName": "platform", "schemaName": "ingest", "tableName": "v_table_freshness"}},
    },
    "context": {"identity": {"user": "analyst", "groups": ["psu_analyst"]}},
  }
}

test_viewer_cannot_read_the_control_plane if {
  not allow with input as {
    "action": {
      "operation": "SelectFromColumns",
      "resource": {"table": {"catalogName": "platform", "schemaName": "ingest", "tableName": "ingest_run"}},
    },
    "context": {"identity": {"user": "viewer", "groups": ["psu_viewer"]}},
  }
}

test_analyst_cannot_write_to_the_control_plane if {
  not allow with input as {
    "action": {
      "operation": "InsertIntoTable",
      "resource": {"table": {"catalogName": "platform", "schemaName": "ingest", "tableName": "source_system"}},
    },
    "context": {"identity": {"user": "analyst", "groups": ["psu_analyst"]}},
  }
}
