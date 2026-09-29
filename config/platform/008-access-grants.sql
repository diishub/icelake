-- Data access for accounts that arrive through single sign-on.
--
-- Signing in proves who someone is. It does not say what they may read, and
-- this stack has no mapping from the PSU directory to the org-unit values the
-- published tables are filtered by -- a faculty name in Thai is not an
-- org_unit key. So a new account starts with no data access at all and an
-- administrator grants it explicitly. That is the difference between
-- authentication and authorisation, and skipping it here would have handed
-- every person with a PSU account the widest view in the policy.
--
-- Reversal: both columns are additive.
--   ALTER TABLE identity.app_user DROP COLUMN access_tier, DROP COLUMN org_unit;

ALTER TABLE identity.app_user
  ADD COLUMN IF NOT EXISTS access_tier text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS org_unit    text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_access_tier_known') THEN
    ALTER TABLE identity.app_user
      ADD CONSTRAINT app_user_access_tier_known
      CHECK (access_tier IN ('none', 'viewer', 'viewer_exec', 'analyst'));
  END IF;

  -- The org unit becomes a Trino group name, so it has to survive as one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_org_unit_shape') THEN
    ALTER TABLE identity.app_user
      ADD CONSTRAINT app_user_org_unit_shape
      CHECK (org_unit IS NULL OR org_unit ~ '^[a-z0-9_-]{1,64}$');
  END IF;

  -- A scoped viewer with no scope reads everything rather than nothing: the
  -- row filter is produced per org unit, so an empty set produces no filter.
  -- The policy now denies that combination; this stops it being recorded.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_viewer_is_scoped') THEN
    ALTER TABLE identity.app_user
      ADD CONSTRAINT app_user_viewer_is_scoped
      CHECK (access_tier <> 'viewer' OR org_unit IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN identity.app_user.access_tier IS
  'What this account may read in Trino. Set by an administrator, never by the sign-in service: none, viewer (needs org_unit), viewer_exec, analyst.';
COMMENT ON COLUMN identity.app_user.org_unit IS
  'Org-unit key used for row filtering, matching the values in the published tables. Becomes the Trino group psu_viewer_org_<org_unit>.';

-- ---------------------------------------------------------------------------
-- The sign-in service cannot grant access, including to itself
-- ---------------------------------------------------------------------------
--
-- 007 granted UPDATE on the whole table, which would now also cover
-- access_tier. Replacing it with column-level grants makes the separation
-- structural rather than a matter of the service being written carefully.

REVOKE UPDATE, INSERT ON identity.app_user FROM identity_app;

GRANT INSERT (subject, psu_username, display_name, email) ON identity.app_user TO identity_app;

GRANT UPDATE (
  psu_username,
  display_name,
  email,
  user_type,
  campus_code,
  campus_name_th,
  faculty_name_th,
  department_name_th,
  major_name_th,
  directory_synced_at,
  last_login_at
) ON identity.app_user TO identity_app;

-- ---------------------------------------------------------------------------
-- What the Trino group file is rendered from
-- ---------------------------------------------------------------------------
--
-- One row per account that has been granted something, already shaped as the
-- group names the policy evaluates. Accounts at tier 'none' do not appear, so
-- the file cannot accidentally carry an empty membership.

CREATE OR REPLACE VIEW identity.v_trino_groups AS
SELECT psu_username AS username,
       access_tier,
       org_unit,
       CASE access_tier
         WHEN 'analyst'     THEN ARRAY['psu_analyst']
         WHEN 'viewer_exec' THEN ARRAY['psu_viewer', 'psu_viewer_exec']
         WHEN 'viewer'      THEN ARRAY['psu_viewer', 'psu_viewer_org_' || org_unit]
       END AS trino_groups
FROM identity.app_user
WHERE is_active
  AND access_tier <> 'none';

COMMENT ON VIEW identity.v_trino_groups IS
  'Source for config/trino groups.txt. Reads nothing but the username and the granted tier: no name, no email, no affiliation.';

GRANT SELECT ON identity.v_trino_groups TO identity_app;
