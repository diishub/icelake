-- Catalogue metadata for the portal.
--
-- The control plane already knows what is ingested and how fresh it is; what
-- it cannot say is what a table is *called* in the language its readers speak,
-- or which part of the university it belongs to. Those three columns are what
-- the portal's catalogue needs and nothing else, so they live here rather than
-- in a second registry that would drift.
--
-- All three are nullable on purpose. A table registered without them is still
-- ingested exactly as before; it simply appears in the catalogue under its
-- technical name and in the "unsorted" group, which is a visible prompt to
-- fill them in rather than a silent default.
--
-- Reversal: the columns are additive and nothing reads them but the catalogue
-- publisher, so
--     ALTER TABLE ingest.source_table
--       DROP COLUMN domain, DROP COLUMN display_name_th, DROP COLUMN description_th;
-- restores the previous shape without touching a row of ingested data.

ALTER TABLE ingest.source_table
  ADD COLUMN IF NOT EXISTS domain          text,
  ADD COLUMN IF NOT EXISTS display_name_th text,
  ADD COLUMN IF NOT EXISTS description_th  text;

-- Three domains, fixed. An unrecognised label would reach the portal as a
-- group heading nobody chose, so the database refuses it here instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'source_table_domain_known'
  ) THEN
    ALTER TABLE ingest.source_table
      ADD CONSTRAINT source_table_domain_known
      CHECK (domain IS NULL OR domain IN ('academic', 'student', 'personnel'));
  END IF;
END
$$;

COMMENT ON COLUMN ingest.source_table.domain IS
  'Portal catalogue grouping: academic, student or personnel. Null means unsorted, which the catalogue shows rather than hides.';
COMMENT ON COLUMN ingest.source_table.display_name_th IS
  'Human title shown in the catalogue. Never a value from the data itself.';
COMMENT ON COLUMN ingest.source_table.description_th IS
  'One sentence on what the table holds, for readers who do not know the source system. Never a sample row.';

-- ---------------------------------------------------------------------------
-- Catalogue view
-- ---------------------------------------------------------------------------
--
-- The publisher reads this view and nothing else. Every column the portal must
-- never receive -- the source host, the credential prefix, the raw error text
-- of a failed run -- is absent here rather than filtered downstream, so the
-- boundary is enforced in one place that can be reviewed on its own.
--
-- "Published" is not a flag anyone sets: a dataset counts as published when it
-- is enabled and has completed at least one successful run. That keeps the
-- portal from promising a table that has never actually landed.

CREATE OR REPLACE VIEW ingest.v_portal_catalog AS
SELECT st.target_schema || '.' || st.target_table_name AS dataset_key,
       COALESCE(st.display_name_th, st.target_table_name) AS title,
       st.description_th                                  AS description,
       COALESCE(st.domain, 'unsorted')                    AS domain,
       ss.display_name                                    AS source_display_name,
       ss.data_owner,
       ss.lawful_basis,
       ss.retention_note,
       st.load_mode,
       st.is_enabled,
       (st.is_enabled AND fr.last_success_started_at IS NOT NULL) AS is_published,
       fr.last_success_started_at,
       fr.last_success_rows,
       fr.last_status,
       fr.skip_reason,
       cls.column_count,
       cls.safe_column_count,
       cls.column_count - cls.safe_column_count AS withheld_column_count
FROM ingest.source_table AS st
JOIN ingest.source_system AS ss USING (source_system_id)
LEFT JOIN ingest.v_table_freshness AS fr
  ON fr.target_table = st.target_schema || '.' || st.target_table_name
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS column_count,
         count(*) FILTER (WHERE cc.is_safe)::integer AS safe_column_count
  FROM ingest.column_classification AS cc
  WHERE cc.source_system_id  = st.source_system_id
    AND cc.source_schema     = st.source_schema
    AND cc.source_table_name = st.source_table_name
) AS cls ON true;

COMMENT ON VIEW ingest.v_portal_catalog IS
  'The only thing the portal catalogue publisher may read. Deliberately omits source host, credential prefix and run error text.';

GRANT SELECT ON ingest.v_portal_catalog TO platform_read;
