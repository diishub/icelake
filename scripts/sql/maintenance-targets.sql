SELECT target_table, target_schema, target_table_name,
       optimize_enabled, expire_snapshots_days, orphan_retention_days
FROM ingest.v_maintenance_targets;
