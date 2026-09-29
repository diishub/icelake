-- Lets a steward upload .pdf/.docx alongside .csv (services/auth/src/
-- server.ts, portal/upload.html). A document has no columns to classify, so
-- its review path (scripts/review-upload.sh --approve-document) differs
-- from the CSV one -- what a reviewer needs instead is the plain text
-- extracted from it, which is why this migration exists: two columns to
-- know what kind of upload this is and where its extracted text sits.
--
-- The extracted text itself is never stored in this database -- it is
-- staged in RustFS beside the original file (services/auth/src/
-- textExtract.ts), the same "log access, not data" boundary
-- identity.login_event and identity.upload_event already keep. This table
-- only ever points at it.
--
-- Reversal:
--   ALTER TABLE identity.upload_event
--     DROP COLUMN file_kind, DROP COLUMN extracted_text_key;

ALTER TABLE identity.upload_event
  ADD COLUMN IF NOT EXISTS file_kind          text NOT NULL DEFAULT 'csv',
  ADD COLUMN IF NOT EXISTS extracted_text_key text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_event_file_kind_known') THEN
    ALTER TABLE identity.upload_event
      ADD CONSTRAINT upload_event_file_kind_known
      CHECK (file_kind IN ('csv', 'pdf', 'docx'));
  END IF;
END
$$;

COMMENT ON COLUMN identity.upload_event.file_kind IS
  'csv, pdf, or docx. Every row before this migration is csv (the only kind accepted until now), which is why the column defaults to it.';
COMMENT ON COLUMN identity.upload_event.extracted_text_key IS
  'RustFS object key for the plain text extracted from a pdf/docx upload (services/auth/src/textExtract.ts), staged beside the original file. Null for csv, and null for a pdf/docx if extraction failed -- the reviewer inspects the original file directly in that case (RustFS Console, README §6.5).';
