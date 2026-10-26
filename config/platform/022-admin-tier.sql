-- An 'admin' access tier: the people who run accounts for the portal.
--
-- Until now an account could only be created or granted a tier from the host
-- (scripts/create-password-account.sh, an UPDATE as the database owner), and
-- the sign-in service was deliberately unable to do either: identity_app has
-- no UPDATE on access_tier and no write on password_hash at all (008, 013).
-- This migration lets an admin do both from the portal's admin page without
-- loosening those grants. identity_app gets EXECUTE on three functions, and
-- nothing else. Each function runs as the database owner, re-checks that the
-- caller is an active admin, enforces what an admin may and may not grant,
-- and writes an audit row in the same transaction as the change.
--
-- An admin runs the portal: manages accounts and reads everything. 'admin'
-- maps to the same Trino group as 'developer' (psu_admin: full, unrestricted
-- access), and psu-auth opens every workspace page a developer can use. That
-- makes granting 'admin' a grant of all data, so every grant is in
-- admin_event. What an admin still cannot do is grant 'developer' or touch a
-- developer's account -- developers are the platform team, provisioned from
-- the host -- or change their own tier or switch themselves off. That last
-- rule is also what keeps the last admin in place: the only admin who could
-- demote them is themselves. The first admin is provisioned from the host
-- (scripts/create-admin-account.sh).
--
-- What this does not protect against: these functions trust the actor id
-- psu-auth passes in, because psu-auth is what authenticated the session. A
-- compromised psu-auth could name any admin as the actor and grant 'admin'
-- -- and with it all data -- to any account. Every change it made would be in
-- admin_event.
--
-- Reversal:
--   DROP FUNCTION identity.admin_create_password_account(uuid, text, text, text, text, text, text);
--   DROP FUNCTION identity.admin_update_account(uuid, uuid, text, text, boolean);
--   DROP FUNCTION identity.admin_reset_password(uuid, uuid, text);
--   DROP FUNCTION identity.assert_admin(uuid);
--   DROP TABLE identity.admin_event;
--   (only once no row holds 'admin') restore app_user_access_tier_known and
--   v_trino_groups from 014-steward-developer-tiers.sql.

-- Guarded like 014's widening, so a later migration that adds a tier is not
-- narrowed back by this one on the next run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_user_access_tier_known'
       AND pg_get_constraintdef(oid) LIKE '%''admin''%'
  ) THEN
    ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_access_tier_known;
    ALTER TABLE identity.app_user
      ADD CONSTRAINT app_user_access_tier_known
      CHECK (access_tier IN ('none', 'viewer', 'viewer_exec', 'analyst', 'steward', 'developer', 'admin'));
  END IF;
END
$$;

CREATE OR REPLACE VIEW identity.v_trino_groups AS
SELECT psu_username AS username,
       access_tier,
       org_unit,
       CASE access_tier
         WHEN 'analyst'     THEN ARRAY['psu_analyst']
         WHEN 'viewer_exec' THEN ARRAY['psu_viewer', 'psu_viewer_exec']
         WHEN 'viewer'      THEN ARRAY['psu_viewer', 'psu_viewer_org_' || org_unit]
         WHEN 'steward'     THEN ARRAY['psu_steward', 'psu_steward_org_' || org_unit]
         -- See 014-steward-developer-tiers.sql: the platform's own admin
         -- group. An admin reads everything; see the header of this file.
         WHEN 'admin'       THEN ARRAY['psu_admin']
         WHEN 'developer'   THEN ARRAY['psu_admin']
       END AS trino_groups
FROM identity.app_user
WHERE is_active
  AND access_tier <> 'none';

COMMENT ON VIEW identity.v_trino_groups IS
  'Source for config/trino groups.txt. Reads nothing but the username and the granted tier: no name, no email, no affiliation.';

GRANT SELECT ON identity.v_trino_groups TO identity_app;

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identity.admin_event (
  event_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Null when the change was made from the host by the database owner
  -- (scripts/create-admin-account.sh), not by an admin in the portal.
  actor_user_id  uuid REFERENCES identity.app_user (user_id) ON DELETE SET NULL,
  target_user_id uuid NOT NULL REFERENCES identity.app_user (user_id) ON DELETE CASCADE,
  action         text NOT NULL,
  -- Tier, org unit and active flag before and after. Never a password or hash.
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_event_action_known
    CHECK (action IN ('account_created', 'account_updated', 'password_reset'))
);

COMMENT ON TABLE identity.admin_event IS
  'Who created, re-tiered, disabled or reset the password of which account, and when. Written only by the admin_* functions in 022-admin-tier.sql and by scripts/create-admin-account.sh.';

CREATE INDEX IF NOT EXISTS admin_event_target_idx ON identity.admin_event (target_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_event_occurred_idx ON identity.admin_event (occurred_at DESC);

GRANT SELECT ON identity.admin_event TO identity_app;

-- ---------------------------------------------------------------------------
-- Admin functions
-- ---------------------------------------------------------------------------
--
-- Errors are raised with a short machine-readable message (SQLSTATE P0001)
-- that services/auth/src/store.ts maps to an API error code. Unique
-- violations on email or psu_username surface as 23505 with the index name.

CREATE OR REPLACE FUNCTION identity.assert_admin(p_actor uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity.app_user
     WHERE user_id = p_actor AND is_active AND access_tier = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION identity.admin_create_password_account(
  p_actor         uuid,
  p_email         text,
  p_display_name  text,
  p_psu_username  text,
  p_password_hash text,
  p_access_tier   text,
  p_org_unit      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_user_id uuid;
BEGIN
  PERFORM identity.assert_admin(p_actor);

  IF p_access_tier NOT IN ('none', 'viewer', 'viewer_exec', 'analyst', 'steward', 'admin') THEN
    RAISE EXCEPTION 'tier_not_assignable';
  END IF;
  -- A bcrypt hash and nothing else: this column is never meant to hold a
  -- plaintext password, even by mistake.
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'invalid_password_hash';
  END IF;

  INSERT INTO identity.app_user (email, display_name, psu_username, password_hash, access_tier, org_unit)
  VALUES (p_email, p_display_name, p_psu_username, p_password_hash, p_access_tier, p_org_unit)
  RETURNING user_id INTO new_user_id;

  INSERT INTO identity.admin_event (actor_user_id, target_user_id, action, detail)
  VALUES (p_actor, new_user_id, 'account_created',
          jsonb_build_object('access_tier', p_access_tier, 'org_unit', p_org_unit, 'is_active', true));

  RETURN new_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION identity.admin_update_account(
  p_actor       uuid,
  p_target      uuid,
  p_access_tier text,
  p_org_unit    text,
  p_is_active   boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior_row identity.app_user%ROWTYPE;
BEGIN
  PERFORM identity.assert_admin(p_actor);

  IF p_target = p_actor THEN
    RAISE EXCEPTION 'self_change_forbidden';
  END IF;

  SELECT * INTO prior_row FROM identity.app_user WHERE user_id = p_target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found';
  END IF;
  IF prior_row.access_tier = 'developer' THEN
    RAISE EXCEPTION 'target_is_developer';
  END IF;
  IF p_access_tier NOT IN ('none', 'viewer', 'viewer_exec', 'analyst', 'steward', 'admin') THEN
    RAISE EXCEPTION 'tier_not_assignable';
  END IF;

  UPDATE identity.app_user
     SET access_tier = p_access_tier,
         org_unit    = p_org_unit,
         is_active   = p_is_active
   WHERE user_id = p_target;

  -- Switching an account off ends its sessions now rather than at expiry.
  IF prior_row.is_active AND NOT p_is_active THEN
    DELETE FROM identity.user_session WHERE user_id = p_target;
  END IF;

  INSERT INTO identity.admin_event (actor_user_id, target_user_id, action, detail)
  VALUES (p_actor, p_target, 'account_updated',
          jsonb_build_object(
            'before', jsonb_build_object('access_tier', prior_row.access_tier, 'org_unit', prior_row.org_unit,
                                         'is_active', prior_row.is_active),
            'after',  jsonb_build_object('access_tier', p_access_tier, 'org_unit', p_org_unit,
                                         'is_active', p_is_active)));
END;
$$;

CREATE OR REPLACE FUNCTION identity.admin_reset_password(
  p_actor         uuid,
  p_target        uuid,
  p_password_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_row identity.app_user%ROWTYPE;
BEGIN
  PERFORM identity.assert_admin(p_actor);

  SELECT * INTO target_row FROM identity.app_user WHERE user_id = p_target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found';
  END IF;
  IF target_row.access_tier = 'developer' THEN
    RAISE EXCEPTION 'target_is_developer';
  END IF;
  -- Adding a password to a PSU Passport account would give it a second way
  -- in that its owner never asked for.
  IF target_row.password_hash IS NULL THEN
    RAISE EXCEPTION 'not_password_account';
  END IF;
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'invalid_password_hash';
  END IF;

  UPDATE identity.app_user SET password_hash = p_password_hash WHERE user_id = p_target;
  -- Whoever held the old password is signed out everywhere.
  DELETE FROM identity.user_session WHERE user_id = p_target;

  INSERT INTO identity.admin_event (actor_user_id, target_user_id, action, detail)
  VALUES (p_actor, p_target, 'password_reset', '{}'::jsonb);
END;
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default.
REVOKE ALL ON FUNCTION identity.assert_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.admin_create_password_account(uuid, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.admin_update_account(uuid, uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.admin_reset_password(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION identity.admin_create_password_account(uuid, text, text, text, text, text, text) TO identity_app;
GRANT EXECUTE ON FUNCTION identity.admin_update_account(uuid, uuid, text, text, boolean) TO identity_app;
GRANT EXECUTE ON FUNCTION identity.admin_reset_password(uuid, uuid, text) TO identity_app;
