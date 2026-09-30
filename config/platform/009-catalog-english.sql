-- English titles and descriptions for the catalogue.
--
-- The portal is bilingual, and a catalogue that switches its chrome to English
-- while every dataset keeps a Thai-only name is not bilingual -- it is a Thai
-- page with English buttons. The names are data, so they live beside the Thai
-- ones rather than in a translation file the database never sees.
--
-- Both are nullable. A dataset with no English name falls back to its Thai
-- name in the published catalogue, which is visible and therefore fixable,
-- rather than appearing as an empty row.
--
-- Reversal:
--   ALTER TABLE ingest.source_table
--     DROP COLUMN display_name_en, DROP COLUMN description_en;
--   then remove title_en/description_en from the SELECT list below and
--   re-run this file, since it is the sole owner of ingest.v_portal_catalog
--   (see the note in 006-catalog-metadata.sql for why).

ALTER TABLE ingest.source_table
  ADD COLUMN IF NOT EXISTS display_name_en text,
  ADD COLUMN IF NOT EXISTS description_en  text;

COMMENT ON COLUMN ingest.source_table.display_name_en IS
  'English title shown in the catalogue. Falls back to the Thai title when absent.';
COMMENT ON COLUMN ingest.source_table.description_en IS
  'One English sentence on what the table holds. Never a sample row.';

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
       cls.column_count - cls.safe_column_count AS withheld_column_count,
       -- Appended rather than placed beside their Thai counterparts: CREATE OR
       -- REPLACE VIEW can only add columns at the end, and dropping the view to
       -- reorder them would buy nothing a reader of the JSON can see.
       COALESCE(st.display_name_en, st.display_name_th, st.target_table_name) AS title_en,
       COALESCE(st.description_en, st.description_th)     AS description_en
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
