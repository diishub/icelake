-- Adds uploader_note (from steward) and rejection_reason (from analyst/reviewer)
-- to identity.upload_event.
--
-- Reversal:
--   ALTER TABLE identity.upload_event
--     DROP COLUMN uploader_note, DROP COLUMN rejection_reason;

ALTER TABLE identity.upload_event
  ADD COLUMN IF NOT EXISTS uploader_note text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

COMMENT ON COLUMN identity.upload_event.uploader_note IS
  'Optional note or message from the uploader/steward explaining the dataset to the reviewer.';
COMMENT ON COLUMN identity.upload_event.rejection_reason IS
  'Reason provided by the analyst/reviewer when an upload is rejected.';
