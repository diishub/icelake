-- Three tiers: admin, analyst, viewer.
--
-- Until PSU Passport is switched on, every account is a password account
-- created by an admin, and the per-unit split (viewer per org unit,
-- viewer_exec, steward per org unit) is more structure than there are people
-- to fill it. This folds those three into one 'viewer':
--
--   viewer   reads published for every org unit (the old viewer_exec's
--            access) and submits files, choosing the org unit per upload
--            instead of carrying one on the account (the old steward's page).
--   analyst  unchanged, except that an analyst now publishes a release
--            directly instead of asking a steward to approve it.
--   admin    unchanged.
--
-- 'none' stays as the state a PSU Passport account is created in at first
-- sign-in (that code is kept for later); the admin page does not offer it.
--
-- Every converted account gets an admin_event row with no actor (a change
-- made from the host) recording its tier and org unit before, which is what
-- the reversal reads.
--
-- The org-unit machinery is left in place for later rather than removed: the
-- OPA rules for psu_viewer_org_* and psu_steward_org_* groups stay (no account
-- is rendered into either group any more), and upload_event and
-- dataset_release keep their org_unit columns.
--
-- 008 and 014 re-add app_user_viewer_is_scoped on every start (migrate.sh
-- re-runs everything); both now skip it once app_user_tier_in_use exists, so
-- this file's removal of it holds.
--
-- Releases: dropping dataset_release_not_self_approved lets the requester be
-- the decider, which psu-auth now does in the same call that records the
-- release. There is no second person reviewing what an analyst publishes;
-- who published what, and when, is still recorded on the release row.
--
-- Reversal:
--   ALTER TABLE identity.app_user DROP CONSTRAINT app_user_tier_in_use;
--   UPDATE identity.app_user u
--      SET access_tier = e.detail -> 'before' ->> 'access_tier',
--          org_unit    = e.detail -> 'before' ->> 'org_unit'
--     FROM identity.admin_event e
--    WHERE e.target_user_id = u.user_id
--      AND e.actor_user_id IS NULL
--      AND e.detail ->> 'reason' = 'three_tiers'
--      AND u.access_tier = 'viewer';
--   ALTER TABLE identity.app_user ADD CONSTRAINT app_user_viewer_is_scoped
--     CHECK (access_tier NOT IN ('viewer', 'steward') OR org_unit IS NOT NULL);
--   ALTER TABLE identity.dataset_release ADD CONSTRAINT dataset_release_not_self_approved
--     CHECK (decided_by IS NULL OR decided_by <> requested_by);
--     (fails while a self-published release exists; those rows would have to
--     be kept out by making it NOT VALID)
--   then re-run 022-admin-tier.sql to restore its v_trino_groups, and revert
--   the matching changes in services/auth and the portal.

BEGIN;

-- Recorded first, while the rows still hold their old tier. On a re-run no
-- row matches, so both statements touch nothing.
INSERT INTO identity.admin_event (actor_user_id, target_user_id, action, detail)
SELECT NULL, user_id, 'account_updated',
       jsonb_build_object(
         'reason', 'three_tiers',
         'before', jsonb_build_object('access_tier', access_tier, 'org_unit', org_unit, 'is_active', is_active),
         'after',  jsonb_build_object('access_tier', 'viewer', 'org_unit', NULL, 'is_active', is_active))
  FROM identity.app_user
 WHERE access_tier IN ('viewer_exec', 'steward')
    OR (access_tier = 'viewer' AND org_unit IS NOT NULL);

ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_viewer_is_scoped;

UPDATE identity.app_user
   SET access_tier = 'viewer', org_unit = NULL
 WHERE access_tier IN ('viewer_exec', 'steward')
    OR (access_tier = 'viewer' AND org_unit IS NOT NULL);

-- Separate from app_user_access_tier_known for the same reason as
-- 023-retire-developer-tier.sql: 014's and 022's guards re-create that one
-- whenever the tier list in it changes.
ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_tier_in_use;
ALTER TABLE identity.app_user
  ADD CONSTRAINT app_user_tier_in_use
  CHECK (access_tier IN ('none', 'viewer', 'analyst', 'admin'));

-- A viewer reads published for every unit, as viewer_exec did: OPA's
-- viewer_is_scoped passes on psu_viewer_exec. 014 and 022 re-create this view
-- with their own tier lists earlier in every run; this one, applied last, is
-- what stays.
CREATE OR REPLACE VIEW identity.v_trino_groups AS
SELECT psu_username AS username,
       access_tier,
       org_unit,
       CASE access_tier
         WHEN 'viewer'  THEN ARRAY['psu_viewer', 'psu_viewer_exec']
         WHEN 'analyst' THEN ARRAY['psu_analyst']
         WHEN 'admin'   THEN ARRAY['psu_admin']
       END AS trino_groups
FROM identity.app_user
WHERE is_active
  AND access_tier <> 'none';

COMMENT ON VIEW identity.v_trino_groups IS
  'Source for config/trino groups.txt. Reads nothing but the username and the granted tier: no name, no email, no affiliation.';

GRANT SELECT ON identity.v_trino_groups TO identity_app;

ALTER TABLE identity.dataset_release DROP CONSTRAINT IF EXISTS dataset_release_not_self_approved;

COMMENT ON COLUMN identity.app_user.access_tier IS
  'What this account may read in Trino. Set by an admin, never by the sign-in service: none (signed in, no access), viewer, analyst, admin. See 024-three-tiers.sql.';

COMMIT;
