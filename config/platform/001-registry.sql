-- Ingestion control plane.
--
-- What belongs here is the state that decides *what* gets ingested and
-- records *what happened* -- never the ingested data itself, and never a
-- credential. Each source is named by an environment-variable prefix so the
-- password stays in the container environment where the rest of this stack
-- keeps its secrets.
--
-- Applied by config/platform/migrate.sh, which is safe to re-run: every
-- statement here is idempotent.

CREATE SCHEMA IF NOT EXISTS ingest;

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.source_system (
  source_system_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key             text    NOT NULL UNIQUE,
  display_name           text    NOT NULL,
  source_kind            text    NOT NULL,
  host                   text    NOT NULL,
  port                   integer NOT NULL,
  database_name          text    NOT NULL,
  -- Name of the environment-variable prefix holding the credentials for this
  -- source, for example SOURCE_SIM for SOURCE_SIM_READER_PASSWORD. The
  -- credential itself is never stored in this database.
  credentials_env_prefix text    NOT NULL,
  -- Schema in the source that holds its own column classification registry.
  -- Null means the source publishes no classification, which the pipeline
  -- treats as "nothing here is known to be safe", not as "all safe".
  registry_schema        text,
  is_enabled             boolean NOT NULL DEFAULT false,
  -- Governance is not optional metadata: a source cannot be registered
  -- without naming who approved it and on what legal basis.
  data_owner             text    NOT NULL,
  lawful_basis           text    NOT NULL,
  retention_note         text    NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_system_kind_known CHECK (source_kind IN ('postgresql')),
  CONSTRAINT source_system_port_valid CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT source_system_governance_stated CHECK (
    length(btrim(data_owner)) > 0
    AND length(btrim(lawful_basis)) > 0
    AND length(btrim(retention_note)) > 0
  )
);

COMMENT ON TABLE ingest.source_system IS
  'Approved ingestion sources. The host is still checked against config/guardrail at run time; a row here does not by itself authorise a connection.';

-- ---------------------------------------------------------------------------
-- Tables to ingest
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.source_table (
  source_table_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system_id      integer NOT NULL REFERENCES ingest.source_system (source_system_id) ON DELETE CASCADE,
  source_schema         text    NOT NULL,
  source_table_name     text    NOT NULL,
  target_schema         text    NOT NULL DEFAULT 'raw',
  target_table_name     text    NOT NULL,
  load_mode             text    NOT NULL DEFAULT 'full_refresh',
  -- Required for incremental loads and meaningless otherwise; the constraint
  -- below makes that impossible to get wrong.
  incremental_column    text,
  is_enabled            boolean NOT NULL DEFAULT false,
  -- Drives the Iceberg maintenance job. Compaction and snapshot expiry are
  -- not only a performance concern: without them, deleted rows stay readable
  -- in old snapshots and orphaned files stay on disk.
  optimize_enabled      boolean NOT NULL DEFAULT true,
  expire_snapshots_days integer NOT NULL DEFAULT 7,
  orphan_retention_days integer NOT NULL DEFAULT 7,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system_id, source_schema, source_table_name),
  UNIQUE (target_schema, target_table_name),
  CONSTRAINT source_table_load_mode_known CHECK (load_mode IN ('full_refresh', 'incremental')),
  CONSTRAINT source_table_incremental_needs_column CHECK (
    (load_mode = 'incremental' AND incremental_column IS NOT NULL)
    OR (load_mode = 'full_refresh' AND incremental_column IS NULL)
  ),
  CONSTRAINT source_table_target_schema_allowed CHECK (target_schema IN ('raw')),
  CONSTRAINT source_table_retention_sane CHECK (
    expire_snapshots_days BETWEEN 1 AND 3650
    AND orphan_retention_days BETWEEN 1 AND 3650
  )
);

-- ---------------------------------------------------------------------------
-- Column classification, mirrored from the registry of each source
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.column_classification (
  source_system_id  integer NOT NULL REFERENCES ingest.source_system (source_system_id) ON DELETE CASCADE,
  source_schema     text    NOT NULL,
  source_table_name text    NOT NULL,
  column_name       text    NOT NULL,
  data_type         text    NOT NULL,
  classification    text    NOT NULL,
  secret_level      integer NOT NULL DEFAULT 0,
  -- The safe / not-safe rule lives here, once, as a generated column, so no
  -- caller can apply its own interpretation. Anything that is not explicitly
  -- public at level 0 is not safe, including a classification label this
  -- platform has never seen before.
  is_safe boolean GENERATED ALWAYS AS (classification = 'public' AND secret_level = 0) STORED,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system_id, source_schema, source_table_name, column_name),
  CONSTRAINT column_classification_secret_level_sane CHECK (secret_level >= 0)
);

COMMENT ON COLUMN ingest.column_classification.is_safe IS
  'Generated: true only for classification public at secret_level 0. An unknown label is never safe.';

-- ---------------------------------------------------------------------------
-- Incremental state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.ingest_watermark (
  source_table_id integer PRIMARY KEY REFERENCES ingest.source_table (source_table_id) ON DELETE CASCADE,
  watermark_value text    NOT NULL,
  watermark_type  text    NOT NULL,
  last_run_id     uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_watermark_type_known CHECK (watermark_type IN ('numeric', 'timestamp', 'text'))
);

-- ---------------------------------------------------------------------------
-- Run log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.ingest_run (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table_id   integer REFERENCES ingest.source_table (source_table_id) ON DELETE SET NULL,
  -- Kept as plain text as well, so the history stays readable after a table
  -- is unregistered and the foreign key goes null.
  source_key        text NOT NULL,
  target_table      text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  status            text NOT NULL DEFAULT 'running',
  skip_reason       text,
  rows_read         bigint,
  rows_written      bigint,
  columns_selected  integer,
  columns_excluded  integer,
  staged_object_key text,
  -- Diagnostics only. Never put a row value, a column value, or a credential
  -- in here: this table is read by dashboards and by support staff.
  error_message     text,
  CONSTRAINT ingest_run_status_known CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT ingest_run_skip_has_reason CHECK (status <> 'skipped' OR skip_reason IS NOT NULL),
  CONSTRAINT ingest_run_failure_has_message CHECK (status <> 'failed' OR error_message IS NOT NULL),
  CONSTRAINT ingest_run_finished_has_end CHECK (status = 'running' OR ended_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ingest_run_started_at_idx ON ingest.ingest_run (started_at DESC);
CREATE INDEX IF NOT EXISTS ingest_run_target_table_idx ON ingest.ingest_run (target_table, started_at DESC);

-- ---------------------------------------------------------------------------
-- Freshness view for the operations dashboard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW ingest.v_table_freshness AS
SELECT st.target_schema || '.' || st.target_table_name AS target_table,
       ss.source_key,
       st.load_mode,
       st.is_enabled,
       last_success.started_at   AS last_success_started_at,
       last_success.rows_written AS last_success_rows,
       last_any.status           AS last_status,
       last_any.started_at       AS last_attempt_started_at,
       last_any.skip_reason,
       now() - last_success.started_at AS age_since_last_success
FROM ingest.source_table AS st
JOIN ingest.source_system AS ss USING (source_system_id)
LEFT JOIN LATERAL (
  SELECT r.started_at, r.rows_written
  FROM ingest.ingest_run AS r
  WHERE r.source_table_id = st.source_table_id AND r.status = 'succeeded'
  ORDER BY r.started_at DESC
  LIMIT 1
) AS last_success ON true
LEFT JOIN LATERAL (
  SELECT r.status, r.started_at, r.skip_reason
  FROM ingest.ingest_run AS r
  WHERE r.source_table_id = st.source_table_id
  ORDER BY r.started_at DESC
  LIMIT 1
) AS last_any ON true;
