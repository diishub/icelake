-- Retires the 'developer' tier: 'admin' is now the one full-access tier.
--
-- 'developer' and 'admin' already read the same data (both render to the
-- psu_admin Trino group, 022-admin-tier.sql); the only difference was that an
-- admin could also manage accounts and a developer could not. Two tiers with
-- the same data access and a different label made it harder to say who holds
-- full access, so every developer account becomes an admin and no account may
-- hold 'developer' again.
--
-- 'developer' is left in app_user_access_tier_known on purpose. Every
-- migration re-runs on every start (migrate.sh), and 014's guard re-creates
-- that constraint -- without 'admin' -- whenever 'developer' is missing from
-- it, which would fail once an admin row exists. A separate constraint refuses
-- the tier instead, so 014 and 022 stay as they are.
--
-- Each converted account gets an admin_event row with no actor (a change made
-- from the host), recording 'developer' as the tier before. That row is what
-- the reversal reads.
--
-- Reversal:
--   ALTER TABLE identity.app_user DROP CONSTRAINT app_user_developer_retired;
--   UPDATE identity.app_user u SET access_tier = 'developer'
--     FROM identity.admin_event e
--    WHERE e.target_user_id = u.user_id
--      AND e.actor_user_id IS NULL
--      AND e.action = 'account_updated'
--      AND e.detail -> 'before' ->> 'access_tier' = 'developer'
--      AND e.detail ->> 'reason' = 'developer_tier_retired'
--      AND u.access_tier = 'admin';
--   (and restore the 'developer' entries this change removed from
--   services/auth and the portal)

-- Recorded first, while the rows still say 'developer'. On a re-run there are
-- no developer rows left, so both statements touch nothing. One transaction,
-- so an account is never converted without its audit row.
BEGIN;

INSERT INTO identity.admin_event (actor_user_id, target_user_id, action, detail)
SELECT NULL, user_id, 'account_updated',
       jsonb_build_object(
         'reason', 'developer_tier_retired',
         'before', jsonb_build_object('access_tier', access_tier, 'org_unit', org_unit, 'is_active', is_active),
         'after',  jsonb_build_object('access_tier', 'admin', 'org_unit', org_unit, 'is_active', is_active))
  FROM identity.app_user
 WHERE access_tier = 'developer';

UPDATE identity.app_user
   SET access_tier = 'admin'
 WHERE access_tier = 'developer';

ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_developer_retired;
ALTER TABLE identity.app_user
  ADD CONSTRAINT app_user_developer_retired
  CHECK (access_tier <> 'developer');

COMMIT;
