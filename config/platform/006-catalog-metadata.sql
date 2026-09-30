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
--
-- ingest.v_portal_catalog itself is defined entirely in
-- 009-catalog-english.sql, not here. CREATE OR REPLACE VIEW cannot remove a
-- column, so a version here would break the moment 009 had run once and
-- added its own columns to the same view -- re-running this file would then
-- try to replace a wider view with a narrower one and fail. One file owning
-- the view avoids that trap; 009 is the one that runs second, so it is the
-- one that owns it.

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
