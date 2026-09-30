-- Two more access tiers: steward (a data owner reviewing their own unit's
-- data) and developer (full platform access, same as the platform's own
-- admin identity -- for this deployment's own team, not for general use).
--
-- Building this surfaced a real gap: identity.v_trino_groups keys the
-- rendered Trino username on psu_username, which only a PSU Passport account
-- has. A password-only account granted a tier had no way to reach Trino under
-- a scoped identity at all -- Superset impersonation and the group file both
-- need *some* username, and there was none to give them. This migration closes
-- that: a password account that is granted a tier now needs a psu_username
-- too (scripts/create-password-account.sh derives one from the email), even
-- though the name no longer means "this account's PSU directory username" for
-- that case -- it means "the identity this account is impersonated as in
-- Trino", which is what it was always used for downstream.
--
-- Reversal:
--   ALTER TABLE identity.app_user
--     DROP CONSTRAINT app_user_password_tier_needs_username;
--   ALTER TABLE identity.app_user
--     DROP CONSTRAINT app_user_viewer_is_scoped;
--   ALTER TABLE identity.app_user
--     ADD CONSTRAINT app_user_viewer_is_scoped
--     CHECK (access_tier <> 'viewer' OR org_unit IS NOT NULL);
--   ALTER TABLE identity.app_user
--     DROP CONSTRAINT app_user_access_tier_known;
--   ALTER TABLE identity.app_user
--     ADD CONSTRAINT app_user_access_tier_known
--     CHECK (access_tier IN ('none', 'viewer', 'viewer_exec', 'analyst'));
--   (only safe once no row still holds 'steward' or 'developer')
--   then re-run 008-access-grants.sql to restore the previous view.

ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_access_tier_known;
ALTER TABLE identity.app_user
  ADD CONSTRAINT app_user_access_tier_known
  CHECK (access_tier IN ('none', 'viewer', 'viewer_exec', 'analyst', 'steward', 'developer'));

-- A steward is always scoped to one org unit -- there is no "steward for the
-- whole university" the way viewer_exec exists for viewers, because the
-- concept being modelled is a specific unit's data owner.
ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_viewer_is_scoped;
ALTER TABLE identity.app_user
  ADD CONSTRAINT app_user_viewer_is_scoped
  CHECK (access_tier NOT IN ('viewer', 'steward') OR org_unit IS NOT NULL);

-- The gap described above, enforced rather than just documented: any granted
-- tier needs a way to reach Trino, which for an OIDC account is the subject
-- (psu_username is filled in from the directory at first sign-in) and for a
-- password account must be psu_username, set explicitly since there is no
-- directory to fill it in from.
ALTER TABLE identity.app_user DROP CONSTRAINT IF EXISTS app_user_password_tier_needs_username;
ALTER TABLE identity.app_user
  ADD CONSTRAINT app_user_password_tier_needs_username
  CHECK (access_tier = 'none' OR subject IS NOT NULL OR psu_username IS NOT NULL);

COMMENT ON CONSTRAINT app_user_password_tier_needs_username ON identity.app_user IS
  'A granted tier must be reachable in Trino. An OIDC account gets psu_username from the directory; a password account must have one set at creation (scripts/create-password-account.sh derives it from the email) before it can be granted anything beyond none.';

CREATE OR REPLACE VIEW identity.v_trino_groups AS
SELECT psu_username AS username,
       access_tier,
       org_unit,
       CASE access_tier
         WHEN 'analyst'     THEN ARRAY['psu_analyst']
         WHEN 'viewer_exec' THEN ARRAY['psu_viewer', 'psu_viewer_exec']
         WHEN 'viewer'      THEN ARRAY['psu_viewer', 'psu_viewer_org_' || org_unit]
         WHEN 'steward'     THEN ARRAY['psu_steward', 'psu_steward_org_' || org_unit]
         -- Deliberately the same group the platform's own administrative
         -- identity uses (config/trino/render-groups.sh renders psu_admin from
         -- PSU_ADMIN_USERNAME) -- OPA's is_admin rule grants full,
         -- unconditional access with no table restriction at all. Reserve this
         -- tier for this deployment's own team, not for a general-purpose
         -- account: there is no lesser privilege between 'analyst' and this.
         WHEN 'developer'   THEN ARRAY['psu_admin']
       END AS trino_groups
FROM identity.app_user
WHERE is_active
  AND access_tier <> 'none';

COMMENT ON VIEW identity.v_trino_groups IS
  'Source for config/trino groups.txt. Reads nothing but the username and the granted tier: no name, no email, no affiliation.';

GRANT SELECT ON identity.v_trino_groups TO identity_app;
