-- Tracks the platform team's review decision on a staged upload
-- (identity.upload_event, config/platform/016-upload-log.sql), made by
-- scripts/review-upload.sh. Additive only, same idempotent style as every
-- other file here.
--
-- No new grant: identity_app has no UPDATE on this table on purpose (016
-- says why), and the review script runs as the database owner, the same
-- privilege pattern config/platform/migrate.sh and
-- scripts/create-password-account.sh both already use.
--
-- Reversal:
--   ALTER TABLE identity.upload_event
--     DROP COLUMN reviewed_by_username, DROP COLUMN reviewed_at,
--     DROP COLUMN target_table, DROP COLUMN columns_included,
--     DROP COLUMN columns_excluded;

ALTER TABLE identity.upload_event
  ADD COLUMN IF NOT EXISTS reviewed_by_username text,
  ADD COLUMN IF NOT EXISTS reviewed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS target_table         text,
  ADD COLUMN IF NOT EXISTS columns_included     integer,
  ADD COLUMN IF NOT EXISTS columns_excluded     integer;

COMMENT ON COLUMN identity.upload_event.target_table IS
  'polaris.raw table the upload landed in once registered -- e.g. steward_eng_system_activity. Null until reviewed.';
COMMENT ON COLUMN identity.upload_event.reviewed_by_username IS
  'Free text, not a foreign key: the platform-team operator who ran scripts/review-upload.sh, not a portal account.';
