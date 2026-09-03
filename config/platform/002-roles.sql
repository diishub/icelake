-- Least-privilege access to the ingestion control plane.
--
-- The pipeline connects as platform_app, never as the PostgreSQL superuser
-- the rest of this stack still shares. platform_app can record what it did
-- and read what it is supposed to ingest; it cannot change the registry, drop
-- anything, or delete its own audit trail.
--
-- Idempotent: re-running this file leaves an existing deployment unchanged.
-- The password is set separately by migrate.sh, from the environment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_read') THEN
    CREATE ROLE platform_read NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN;
  END IF;
END
$$;

REVOKE ALL ON DATABASE platform FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO platform_app;

GRANT USAGE ON SCHEMA ingest TO platform_read;

-- Read-only group role: everything in the schema, nothing more.
GRANT SELECT ON ALL TABLES IN SCHEMA ingest TO platform_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA ingest GRANT SELECT ON TABLES TO platform_read;

GRANT platform_read TO platform_app;

-- The registry itself is operator-maintained. The pipeline reads it and must
-- not be able to enable a source or widen a target for itself.
-- Writes are limited to the three tables that record what a run observed.
GRANT INSERT, UPDATE ON ingest.column_classification TO platform_app;
GRANT INSERT, UPDATE ON ingest.ingest_watermark      TO platform_app;
GRANT INSERT, UPDATE ON ingest.ingest_run            TO platform_app;

-- Identity columns need their sequences.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ingest TO platform_app;

-- Trino reads the control plane through its own login, separate from the
-- pipeline identity: dashboards need to see run history, and nothing about
-- showing a dashboard requires the ability to write to it. The password is
-- set by migrate.sh from the environment.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_trino') THEN
    CREATE ROLE platform_trino LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE platform TO platform_trino;
GRANT platform_read TO platform_trino;
