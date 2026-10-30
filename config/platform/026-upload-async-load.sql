-- Approving a CSV upload loads it into Iceberg after the response has gone.
--
-- The load (services/auth/src/trino.ts bridgeCsvToIceberg) can run longer
-- than nginx waits for /auth/ (config/portal/default.conf), so the reviewer
-- saw a 504 for an approval that went on to succeed. psu-auth now claims the
-- row as 'loading', answers 202, and the portal polls the row until it
-- leaves 'loading'. The same pattern dataset_release uses for its copy.
--
--   loading         claimed by a reviewer, load running in psu-auth
--   registered      load finished (unchanged)
--   pending_review  load failed or was cut off by a restart; load_error says
--                   which, as a short code, so the reviewer can try again.
--                   The Trino detail stays in the psu-auth log.
--
-- upload_event_status_known (016) is replaced by upload_event_status_in_use;
-- 016 creates its constraint only with the table, so a re-run of 016 does not
-- bring the old one back.
--
-- Reversal:
--   UPDATE identity.upload_event SET status = 'pending_review' WHERE status = 'loading';
--   ALTER TABLE identity.upload_event DROP CONSTRAINT upload_event_status_in_use;
--   ALTER TABLE identity.upload_event ADD CONSTRAINT upload_event_status_known
--     CHECK (status IN ('pending_review', 'registered', 'rejected'));
--   REVOKE UPDATE (load_error) ON identity.upload_event FROM identity_app;
--   ALTER TABLE identity.upload_event DROP COLUMN load_error;
--   and revert the matching changes in services/auth and the portal.

BEGIN;

ALTER TABLE identity.upload_event
  ADD COLUMN IF NOT EXISTS load_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'identity.upload_event'::regclass
       AND conname = 'upload_event_status_in_use'
  ) THEN
    ALTER TABLE identity.upload_event DROP CONSTRAINT IF EXISTS upload_event_status_known;
    ALTER TABLE identity.upload_event ADD CONSTRAINT upload_event_status_in_use
      CHECK (status IN ('pending_review', 'loading', 'registered', 'rejected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'identity.upload_event'::regclass
       AND conname = 'upload_event_load_error_shape'
  ) THEN
    ALTER TABLE identity.upload_event ADD CONSTRAINT upload_event_load_error_shape
      CHECK (load_error IS NULL OR load_error ~ '^[a-z_]{1,64}$');
  END IF;
END
$$;

COMMENT ON COLUMN identity.upload_event.load_error IS
  'Short code for why the last Iceberg load of this upload failed; NULL when none failed. Detail is in the psu-auth log.';

GRANT UPDATE (load_error) ON identity.upload_event TO identity_app;

COMMIT;
