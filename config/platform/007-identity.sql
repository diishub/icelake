-- Identity for the portal: who signed in, and which directory group they are in.
--
-- This is the first schema in this stack that holds real personal data. Every
-- other table here describes synthetic rows or pipeline state; these describe
-- actual staff and students, so the rules are written into the structure rather
-- than into a document beside it:
--
--   * Purpose: decide what a signed-in person may open in the portal, and show
--     them their own affiliation. Nothing here feeds a report or a dataset.
--   * Lawful basis: performance of the university's task in the public
--     interest (PDPA s.24(4)) -- access control for a university information
--     system used by its own staff and students.
--   * Minimisation: only the fields the two decisions above need. The PSU
--     gateway also returns names, nationality, study status, email addresses
--     and telephone numbers for the person looked up; none of those are read,
--     typed or stored. See services/auth/src/directory.ts.
--   * Retention: enforced by identity.purge_expired(), not by intention.
--     Sessions die at expiry, login events at 180 days, dormant accounts at
--     24 months without a login.
--   * Logging: the login event records that a sign-in happened and how it
--     ended. No address, no device, no claim payload.
--
-- Reversal: DROP SCHEMA identity CASCADE removes everything added here and
-- nothing else; no other schema references it.

CREATE SCHEMA IF NOT EXISTS identity;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identity.app_user (
  user_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The OIDC subject, which is the only identifier PSU Passport guarantees to
  -- be stable. The username is what the directory gateway is keyed by, so both
  -- are kept; neither is derived from the other.
  subject      text NOT NULL UNIQUE,
  psu_username text NOT NULL UNIQUE,
  display_name text,
  email        text,
  -- Set from whichever directory endpoint answered, never from the shape of
  -- the username. 'unknown' is a real state: the gateway may be unreachable,
  -- and the portal must fail closed rather than guess a group.
  user_type    text NOT NULL DEFAULT 'unknown',
  campus_code        text,
  campus_name_th     text,
  faculty_name_th    text,
  department_name_th text,
  major_name_th      text,
  directory_synced_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  is_active     boolean NOT NULL DEFAULT true,
  CONSTRAINT app_user_type_known CHECK (user_type IN ('student', 'staff', 'unknown')),
  CONSTRAINT app_user_username_lowercase CHECK (psu_username = lower(psu_username))
);

COMMENT ON TABLE identity.app_user IS
  'Portal accounts created on first PSU Passport sign-in. Personal data: lawful basis PDPA s.24(4), purpose access control, retention 24 months after last login.';
COMMENT ON COLUMN identity.app_user.user_type IS
  'student, staff, or unknown. Decided by which PSU directory endpoint answered, never by the username pattern.';
COMMENT ON COLUMN identity.app_user.email IS
  'Stored only to map a person to their reporting account. Never written to a log, a URL or a dataset.';

CREATE INDEX IF NOT EXISTS app_user_last_login_idx ON identity.app_user (last_login_at DESC);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
--
-- The cookie holds a random token; this table holds its SHA-256. A dump of
-- this database therefore cannot be replayed as a live session, which is the
-- same reason a password file holds hashes.

CREATE TABLE IF NOT EXISTS identity.user_session (
  session_hash text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES identity.app_user (user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT user_session_expires_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS user_session_user_idx ON identity.user_session (user_id);
CREATE INDEX IF NOT EXISTS user_session_expires_idx ON identity.user_session (expires_at);

COMMENT ON COLUMN identity.user_session.session_hash IS
  'SHA-256 of the session cookie value. The cookie itself is never stored.';

-- ---------------------------------------------------------------------------
-- Login log
-- ---------------------------------------------------------------------------
--
-- Records that an access decision was made and how it ended. The reason is a
-- fixed code, not free text, so a future change cannot quietly start writing a
-- claim payload or an address into an audit table.

CREATE TABLE IF NOT EXISTS identity.login_event (
  event_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES identity.app_user (user_id) ON DELETE SET NULL,
  outcome     text NOT NULL,
  reason      text NOT NULL,
  CONSTRAINT login_event_outcome_known CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  CONSTRAINT login_event_reason_known CHECK (reason IN (
    'signed_in',
    'signed_out',
    'session_expired',
    'state_mismatch',
    'token_exchange_failed',
    'claims_incomplete',
    'directory_unavailable',
    'account_disabled'
  ))
);

CREATE INDEX IF NOT EXISTS login_event_occurred_idx ON identity.login_event (occurred_at DESC);

COMMENT ON TABLE identity.login_event IS
  'Access log, not a data log: who signed in and how it ended. No address, device or claim payload. Retention 180 days, enforced by identity.purge_expired().';

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because the application role must be able to run the purge
-- without being granted DELETE on the audit table, which would also let it
-- erase its own trail selectively. The function deletes only by age.

CREATE OR REPLACE FUNCTION identity.purge_expired()
RETURNS TABLE (sessions_removed bigint, events_removed bigint, accounts_removed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, pg_temp
AS $$
DECLARE
  removed_sessions bigint;
  removed_events   bigint;
  removed_accounts bigint;
BEGIN
  DELETE FROM identity.user_session WHERE expires_at < now();
  GET DIAGNOSTICS removed_sessions = ROW_COUNT;

  DELETE FROM identity.login_event WHERE occurred_at < now() - interval '180 days';
  GET DIAGNOSTICS removed_events = ROW_COUNT;

  DELETE FROM identity.app_user WHERE last_login_at < now() - interval '24 months';
  GET DIAGNOSTICS removed_accounts = ROW_COUNT;

  RETURN QUERY SELECT removed_sessions, removed_events, removed_accounts;
END;
$$;

COMMENT ON FUNCTION identity.purge_expired() IS
  'Applies the retention periods stated on each table. Run on a schedule; safe to run at any time.';

-- ---------------------------------------------------------------------------
-- Least-privilege application role
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE platform TO identity_app;
GRANT USAGE ON SCHEMA identity TO identity_app;

GRANT SELECT, INSERT, UPDATE ON identity.app_user    TO identity_app;
GRANT SELECT, INSERT, DELETE ON identity.user_session TO identity_app;
GRANT INSERT                 ON identity.login_event  TO identity_app;
GRANT UPDATE                 ON identity.user_session TO identity_app;
GRANT EXECUTE ON FUNCTION identity.purge_expired()    TO identity_app;

-- Deliberately not granted: DELETE on app_user or login_event. An account is
-- deactivated by is_active, and the audit trail is only ever shortened by the
-- retention function above.
REVOKE DELETE ON identity.app_user   FROM identity_app;
REVOKE DELETE ON identity.login_event FROM identity_app;

-- The ingestion identity has no business reading who signed in.
REVOKE ALL ON SCHEMA identity FROM platform_app, platform_read;
