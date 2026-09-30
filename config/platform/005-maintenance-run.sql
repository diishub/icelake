-- Record of table maintenance, kept for the same reason as ingest_run: an
-- operation that deletes files needs a trail showing when it ran and what it
-- touched.
--
-- This matters beyond housekeeping. Dropping an Iceberg table in this stack
-- does not delete its data files, so a deletion request is only actually
-- satisfied once orphan-file removal has run over the affected location.

CREATE TABLE IF NOT EXISTS ingest.maintenance_run (
  maintenance_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_table       text NOT NULL,
  action             text NOT NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  status             text NOT NULL DEFAULT 'running',
  -- Retention actually applied, so a run that used a shorter threshold than
  -- the registry default is visible afterwards rather than being inferred.
  retention_applied  text,
  detail             text,
  CONSTRAINT maintenance_run_action_known
    CHECK (action IN ('optimize', 'expire_snapshots', 'remove_orphan_files')),
  CONSTRAINT maintenance_run_status_known
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT maintenance_run_finished_has_end
    CHECK (status = 'running' OR ended_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS maintenance_run_started_at_idx
  ON ingest.maintenance_run (started_at DESC);

GRANT INSERT, UPDATE ON ingest.maintenance_run TO platform_app;

-- What the maintenance job needs to know, in one place, so the job itself
-- carries no policy.
CREATE OR REPLACE VIEW ingest.v_maintenance_targets AS
SELECT st.target_schema || '.' || st.target_table_name AS target_table,
       st.target_schema,
       st.target_table_name,
       st.optimize_enabled,
       st.expire_snapshots_days,
       st.orphan_retention_days
FROM ingest.source_table AS st
JOIN ingest.source_system AS ss USING (source_system_id)
WHERE st.is_enabled AND ss.is_enabled
  -- A registered table that has never been loaded has no Iceberg table to
  -- maintain. Skipping it here keeps a skip from being reported as a
  -- maintenance failure, which would train people to ignore failures.
  AND EXISTS (SELECT 1 FROM ingest.ingest_run AS r
              WHERE r.source_table_id = st.source_table_id
                AND r.status = 'succeeded' AND r.rows_written > 0)
ORDER BY 1;
