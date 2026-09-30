-- Audit trail for steward file uploads (portal/upload.html -> psu-auth ->
-- RustFS staging). This is a log of what was staged, not a registration: it
-- does not touch ingest.source_table or ingest.column_classification, and
-- staging a file grants it no path into Iceberg by itself. Turning a staged
-- upload into a registered, classified, publishable table stays a platform-
-- team action via the existing registry (README section 6.8) -- an
-- uploaded file has had no human column-classification/lawful-basis review
-- yet, the same reason ingestion from a database source requires one before
-- any column is ever selected.
--
-- Lives in the identity schema/role, not ingest/platform_app: psu-auth
-- already connects here and nowhere else (services/auth/src/config.ts), and
-- an upload is fundamentally about an *account*'s action, the same shape as
-- identity.login_event.
--
-- Reversal: DROP TABLE identity.upload_event;

CREATE TABLE IF NOT EXISTS identity.upload_event (
  upload_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES identity.app_user (user_id) ON DELETE CASCADE,
  org_unit      text NOT NULL,
  object_key    text NOT NULL,
  original_filename text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'pending_review',
  CONSTRAINT upload_event_status_known CHECK (status IN ('pending_review', 'registered', 'rejected'))
);

CREATE INDEX IF NOT EXISTS upload_event_user_idx ON identity.upload_event (user_id);
CREATE INDEX IF NOT EXISTS upload_event_uploaded_idx ON identity.upload_event (uploaded_at DESC);

COMMENT ON TABLE identity.upload_event IS
  'Audit trail for steward file uploads staged in RustFS. status starts pending_review and is moved on by a platform-team operator, not by this service -- see README section 6.8.';
COMMENT ON COLUMN identity.upload_event.object_key IS
  'RustFS object key under staging/uploads/<org_unit>/... -- the file itself, not a copy of it.';

GRANT SELECT, INSERT ON identity.upload_event TO identity_app;

-- Deliberately no UPDATE/DELETE: moving a row past pending_review, or
-- removing one, is an operator action against the database directly, not a
-- capability the sign-in service needs.
