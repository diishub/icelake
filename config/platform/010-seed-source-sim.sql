-- Development seed: register the synthetic source and the tables the pipeline
-- is expected to handle. Idempotent, so re-running the migration leaves any
-- operator edits to these rows alone.
--
-- The set of tables here is chosen to cover every case the pipeline has to
-- get right, not just the easy ones:
--   * pure lookup tables with nothing sensitive
--   * mixed tables where most columns are blocked
--   * an incremental table
--   * a table whose columns are all sensitive, enabled on purpose, because
--     the pipeline must skip it and say why rather than fall back to
--     selecting everything
--   * a table the source owner has withdrawn, left disabled

INSERT INTO ingest.source_system (
  source_key, display_name, source_kind, host, port, database_name,
  credentials_env_prefix, registry_schema, is_enabled,
  data_owner, lawful_basis, retention_note
) VALUES (
  'source-sim',
  'Synthetic source warehouse (generated data)',
  'postgresql',
  :'source_sim_host',
  :'source_sim_port',
  :'source_sim_db',
  'SOURCE_SIM',
  'meta',
  true,
  'PSU DIIS ISD platform team',
  'Not applicable: every row in this source is generated, so no personal data is processed',
  'No retention limit: synthetic data, deleted whenever the container is rebuilt'
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO ingest.source_table (
  source_system_id, source_schema, source_table_name,
  target_schema, target_table_name, load_mode, incremental_column, is_enabled
)
SELECT ss.source_system_id, v.source_schema, v.source_table_name,
       'raw', v.target_table_name, v.load_mode, v.incremental_column, v.is_enabled
FROM ingest.source_system AS ss
CROSS JOIN (VALUES
  ('hr',       'department',      'sim_hr_department',      'full_refresh', NULL,            true),
  ('hr',       'position',        'sim_hr_position',        'full_refresh', NULL,            true),
  ('academic', 'course',          'sim_academic_course',    'full_refresh', NULL,            true),
  ('hr',       'employee',        'sim_hr_employee',        'full_refresh', NULL,            true),
  ('academic', 'student',         'sim_academic_student',   'full_refresh', NULL,            true),
  ('academic', 'enrollment',      'sim_academic_enrollment', 'incremental', 'enrollment_id', true),
  ('hr',       'employee_health', 'sim_hr_employee_health', 'full_refresh', NULL,            true),
  ('hr',       'retired_lookup',  'sim_hr_retired_lookup',  'full_refresh', NULL,            false)
) AS v (source_schema, source_table_name, target_table_name, load_mode, incremental_column, is_enabled)
WHERE ss.source_key = 'source-sim'
ON CONFLICT (source_system_id, source_schema, source_table_name) DO NOTHING;
