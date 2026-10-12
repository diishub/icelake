-- Dataset releases: how a curated table becomes a published one.
--
-- Until now anything in polaris.published got there by someone with write
-- access deciding to put it there. A release makes that a recorded event with
-- two people on it: an analyst asks for a curated table to be published, and
-- the data owner for that org unit (a steward) or a platform developer
-- approves it. Only then does psu-auth copy the table, as the Trino publisher
-- identity, which is the only non-admin identity OPA lets write published.
--
-- What a release pins is a curated Iceberg snapshot, not "whatever curated
-- holds when the copy runs". The published table's own snapshot is recorded
-- too, so a download or an API answer can name exactly which data it came
-- from and an earlier version stays readable with FOR VERSION AS OF until
-- snapshot expiry removes it.
--
-- The published table always has the same name as its curated source. That
-- is not tidiness: org_scoped_tables.json is matched on table name alone, so a
-- curated table that is row-filtered by org unit stays row-filtered once
-- published. A rename here would have quietly dropped that filter.
--
-- Lives in the identity schema for the same reason upload_event does
-- (016-upload-log.sql): psu-auth connects here and nowhere else, and a release
-- is a decision made by accounts.
--
-- Reversal:
--   DROP VIEW identity.v_published_release;
--   DROP TABLE identity.dataset_release;

CREATE TABLE IF NOT EXISTS identity.dataset_release (
  release_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name            text NOT NULL,
  version               integer NOT NULL CHECK (version > 0),

  title_th              text NOT NULL CHECK (length(btrim(title_th)) BETWEEN 1 AND 200),
  title_en              text CHECK (title_en IS NULL OR length(title_en) <= 200),
  description_th        text CHECK (description_th IS NULL OR length(description_th) <= 2000),
  description_en        text CHECK (description_en IS NULL OR length(description_en) <= 2000),
  domain                text,
  tags                  text[] NOT NULL DEFAULT '{}',
  owner_org_unit        text NOT NULL,
  access_level          text NOT NULL DEFAULT 'university',
  refresh_cadence       text NOT NULL DEFAULT 'manual',
  changelog             text CHECK (changelog IS NULL OR length(changelog) <= 2000),

  status                text NOT NULL DEFAULT 'requested',
  requested_by          uuid NOT NULL REFERENCES identity.app_user (user_id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  decided_by            uuid REFERENCES identity.app_user (user_id),
  decided_at            timestamptz,
  rejection_reason      text CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 1000),

  source_snapshot_id    bigint,
  published_snapshot_id bigint,
  row_count             bigint CHECK (row_count IS NULL OR row_count >= 0),
  published_at          timestamptz,
  -- A short, fixed failure code for the requester and reviewer. Trino's own
  -- error text stays in the service log: it can name hosts and internals.
  failure_code          text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,64}$'),

  -- Same shape the Trino identifiers are checked against in psu-auth; the
  -- name is interpolated into SQL there, so the database refuses anything
  -- else as a second line rather than trusting one.
  CONSTRAINT dataset_release_table_name_shape CHECK (table_name ~ '^[a-z][a-z0-9_]{0,127}$'),
  CONSTRAINT dataset_release_org_unit_shape CHECK (owner_org_unit ~ '^[a-z0-9_-]{1,64}$'),
  CONSTRAINT dataset_release_domain_known CHECK (domain IS NULL OR domain IN (
    'student', 'personnel', 'research', 'academic_services', 'indicator'
  )),
  CONSTRAINT dataset_release_access_level_known CHECK (access_level IN ('university', 'restricted')),
  CONSTRAINT dataset_release_cadence_known CHECK (refresh_cadence IN ('manual', 'daily', 'weekly', 'monthly')),
  CONSTRAINT dataset_release_status_known CHECK (status IN (
    'requested', 'approved', 'published', 'failed', 'rejected'
  )),
  CONSTRAINT dataset_release_tags_bounded CHECK (cardinality(tags) <= 10),
  CONSTRAINT dataset_release_version_unique UNIQUE (table_name, version),

  -- The point of the whole table: nobody approves their own request.
  -- Enforced here as well as in psu-auth, so a bug there cannot undo it.
  CONSTRAINT dataset_release_not_self_approved CHECK (decided_by IS NULL OR decided_by <> requested_by),
  -- Every state past 'requested' was reached by a named decision.
  CONSTRAINT dataset_release_decided CHECK (
    status = 'requested' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT dataset_release_rejection_has_reason CHECK (
    status <> 'rejected' OR length(btrim(coalesce(rejection_reason, ''))) > 0
  ),
  CONSTRAINT dataset_release_published_is_pinned CHECK (
    status <> 'published'
    OR (source_snapshot_id IS NOT NULL AND published_snapshot_id IS NOT NULL AND published_at IS NOT NULL)
  )
);

-- One open request per table at a time. Two approved requests for the same
-- table racing each other would publish in whichever order Trino finished.
CREATE UNIQUE INDEX IF NOT EXISTS dataset_release_one_open_per_table
  ON identity.dataset_release (table_name)
  WHERE status IN ('requested', 'approved');

CREATE INDEX IF NOT EXISTS dataset_release_status_idx
  ON identity.dataset_release (status, requested_at DESC);

COMMENT ON TABLE identity.dataset_release IS
  'Requests to publish a polaris.curated table into polaris.published, and their decisions. Written by psu-auth; see 021-dataset-release.sql.';
COMMENT ON COLUMN identity.dataset_release.source_snapshot_id IS
  'The curated Iceberg snapshot this release copied, captured at approval.';
COMMENT ON COLUMN identity.dataset_release.published_snapshot_id IS
  'The published table''s snapshot right after the copy: what a download or API answer for this version reads.';
COMMENT ON COLUMN identity.dataset_release.access_level IS
  'university: any account with read access to published. restricted: by request only (access requests are a later phase; until then it is shown but not served).';

-- psu-auth records requests and decisions. It cannot rewrite who asked, what
-- was asked for, or the version: those columns have no UPDATE grant, and
-- there is no DELETE at all.
GRANT SELECT ON identity.dataset_release TO identity_app;
GRANT INSERT (table_name, version, title_th, title_en, description_th, description_en,
              domain, tags, owner_org_unit, access_level, refresh_cadence, changelog,
              requested_by)
  ON identity.dataset_release TO identity_app;
GRANT UPDATE (status, decided_by, decided_at, rejection_reason, source_snapshot_id,
              published_snapshot_id, row_count, published_at, failure_code)
  ON identity.dataset_release TO identity_app;

-- The latest published version of each table, metadata only: what the portal
-- catalogue lists. No account ids, no snapshot ids, no failure codes.
CREATE OR REPLACE VIEW identity.v_published_release AS
SELECT DISTINCT ON (r.table_name)
       r.table_name,
       r.version,
       r.title_th,
       r.title_en,
       r.description_th,
       r.description_en,
       r.domain,
       r.tags,
       r.owner_org_unit,
       r.access_level,
       r.refresh_cadence,
       r.row_count,
       r.published_at
FROM identity.dataset_release AS r
WHERE r.status = 'published'
ORDER BY r.table_name, r.version DESC;

COMMENT ON VIEW identity.v_published_release IS
  'Latest published version per table, metadata only. Source for GET /auth/catalog/releases.';

GRANT SELECT ON identity.v_published_release TO identity_app;
