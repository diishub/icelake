-- Replace the catalogue's 3 fixed domains with 5, matching the categories
-- the portal now groups datasets by: student, personnel, research, academic
-- services and indicator. The old 'academic' domain (course catalogue and
-- enrolment) is retired rather than folded into one of the new domains --
-- teaching data is neither research nor an academic service, so forcing it
-- into either would be a wrong label, not a migration. Both rows fall back to
-- NULL ("unsorted"), the same visible-prompt-to-classify state
-- 006-catalog-metadata.sql already designed for a table with no domain set.
--
-- Reversal:
--   UPDATE ingest.source_table SET domain = 'academic'
--     WHERE target_table_name IN ('sim_academic_course', 'sim_academic_enrollment');
--   ALTER TABLE ingest.source_table DROP CONSTRAINT source_table_domain_known;
--   ALTER TABLE ingest.source_table
--     ADD CONSTRAINT source_table_domain_known
--     CHECK (domain IS NULL OR domain IN ('academic', 'student', 'personnel'));

UPDATE ingest.source_table
   SET domain = NULL
 WHERE domain = 'academic';

ALTER TABLE ingest.source_table DROP CONSTRAINT IF EXISTS source_table_domain_known;

ALTER TABLE ingest.source_table
  ADD CONSTRAINT source_table_domain_known
  CHECK (domain IS NULL OR domain IN (
    'student', 'personnel', 'research', 'academic_services', 'indicator'
  ));

COMMENT ON COLUMN ingest.source_table.domain IS
  'Portal catalogue grouping: student, personnel, research, academic_services or indicator. Null means unsorted, which the catalogue shows rather than hides.';
