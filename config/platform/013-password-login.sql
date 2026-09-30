-- Email-and-password sign-in, alongside PSU Passport.
--
-- Accounts are provisioned by an administrator (scripts/create-password-account.sh),
-- never through a public sign-up form -- the sign-in service is never granted
-- INSERT on password_hash (see the grant at the bottom of this file), so it
-- cannot create one even if a route mistakenly tried to.
--
-- A password-only account has neither an OIDC subject nor a PSU directory
-- username, so both become optional here. What stays fixed is that every
-- account is reachable by at least one authentication method, and that a
-- viewer with 'viewer' access still needs an org unit -- both enforced as
-- CHECK constraints rather than left to application code to remember.
--
-- Reversal:
--   ALTER TABLE identity.app_user
--     DROP CONSTRAINT app_user_has_auth_method,
--     DROP COLUMN password_hash,
--     ALTER COLUMN subject SET NOT NULL,
--     ALTER COLUMN psu_username SET NOT NULL;
--   DROP INDEX identity.app_user_email_unique_idx;
--   (only safe once every password-only row has been removed first, since the
--   NOT NULL constraints would otherwise reject them)

ALTER TABLE identity.app_user
  ALTER COLUMN subject DROP NOT NULL,
  ALTER COLUMN psu_username DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS password_hash text;

COMMENT ON COLUMN identity.app_user.password_hash IS
  'bcrypt hash for email-and-password sign-in. Null for a PSU-Passport-only account. Never logged, never returned to the browser; read only by services/auth/src/store.ts for verification.';

-- Email is the login identifier for a password account, so it must be unique
-- once one exists. Partial and case-insensitive: an OIDC-only account with no
-- email, or two different-case spellings of one PSU Passport account's email
-- captured before this feature existed, must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_unique_idx
  ON identity.app_user (lower(email))
  WHERE email IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_has_auth_method') THEN
    ALTER TABLE identity.app_user
      ADD CONSTRAINT app_user_has_auth_method
      CHECK (subject IS NOT NULL OR password_hash IS NOT NULL);
  END IF;
END
$$;

COMMENT ON CONSTRAINT app_user_has_auth_method ON identity.app_user IS
  'Every account must be reachable somehow: a PSU Passport subject, a password hash, or both.';

-- ---------------------------------------------------------------------------
-- Login log: two new denial reasons
-- ---------------------------------------------------------------------------
--
-- Rebuilding the CHECK rather than leaving the old one and adding a second:
-- Postgres has no ALTER CONSTRAINT for a CHECK's expression, so the existing
-- one is dropped and recreated with the fuller list. This is additive to the
-- set of accepted values, not a narrowing, so every row already in the table
-- still satisfies it.

ALTER TABLE identity.login_event DROP CONSTRAINT IF EXISTS login_event_reason_known;

ALTER TABLE identity.login_event
  ADD CONSTRAINT login_event_reason_known
  CHECK (reason IN (
    'signed_in',
    'signed_out',
    'session_expired',
    'state_mismatch',
    'token_exchange_failed',
    'claims_incomplete',
    'directory_unavailable',
    'account_disabled',
    'invalid_credentials',
    'rate_limited'
  ));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Deliberately unchanged: identity_app already has table-wide SELECT from
-- migration 007 (never revoked), which is what verifying a password requires.
-- It is not granted INSERT or UPDATE on password_hash in either migration 007,
-- 008 or here -- provisioning runs as the database owner (psu), the same
-- pattern config/platform/migrate.sh and scripts/create-password-account.sh
-- both use, precisely so the sign-in service can never write a password.
