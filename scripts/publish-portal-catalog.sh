#!/bin/sh
# Publish the dataset catalogue the portal reads.
#
# The portal is static files behind nginx with a CSP of connect-src 'self'. It
# has no route to the control-plane database and is not given one: this script
# is the only thing that crosses that boundary, and it crosses it in one
# direction, on demand, writing a file.
#
# Why a generated file rather than an API:
#   * the filtering happens in one reviewable place instead of in whichever
#     handler happens to serve a request
#   * no browser, authenticated or not, can reach the control plane even
#     indirectly
#   * the catalogue is small enough that search runs in the page, which is
#     faster than a round trip and works while the database is down
#
# The cost is that the file is only as fresh as the last run, so the document
# carries generated_at and the portal shows it. Run this after
# scripts/run-ingest-once.sh, or on a schedule.
#
# Reads ingest.v_portal_catalog and nothing else. That view omits the source
# host, the credential environment prefix and raw run error text by
# construction -- see config/platform/006-catalog-metadata.sql.
#
# Each dataset carries both languages. The portal picks one at render time, so
# switching language never refetches and never leaves half the page translated.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

output_file="portal/data/catalog.json"
temp_file="${output_file}.tmp"

if [ ! -f .env ]; then
  echo "no .env in ${repo_dir}" >&2
  exit 1
fi

platform_password="$(grep '^PLATFORM_DB_PASSWORD=' .env | cut -d= -f2-)"
if [ -z "${platform_password}" ]; then
  echo "PLATFORM_DB_PASSWORD is not set in .env" >&2
  exit 1
fi

mkdir -p "$(dirname -- "${output_file}")"

# Built as one JSON document by the database rather than assembled in the
# shell, so no value is ever concatenated into a string that could break the
# structure or escape it.
docker compose exec -T -e PGPASSWORD="${platform_password}" postgres \
  psql --host 127.0.0.1 --username platform_app --dbname platform \
    --no-align --tuples-only --quiet --no-psqlrc --set ON_ERROR_STOP=1 -f - > "${temp_file}" <<'SQL'
WITH catalog AS (
  SELECT c.*,
         CASE
           WHEN NOT c.is_enabled                     THEN 'retired'
           WHEN c.is_published                       THEN 'published'
           WHEN c.last_status = 'skipped'            THEN 'withheld'
           ELSE 'pending'
         END AS availability
  FROM ingest.v_portal_catalog AS c
),
runs AS (
  SELECT count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded_7d,
         count(*)::integer                                     AS total_7d
  FROM ingest.ingest_run
  WHERE started_at > now() - interval '7 days'
),
domain_label AS (
  SELECT * FROM (VALUES
    ('academic',  'วิชาการ',      'Academic',   1),
    ('student',   'นักศึกษา',     'Students',   2),
    ('personnel', 'บุคลากร',      'Staff',      3),
    ('unsorted',  'ยังไม่จัดหมวด', 'Unsorted',   4)
  ) AS d (key, label, label_en, sort_order)
)
SELECT json_build_object(
  'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'stats', json_build_object(
    'datasets_total',     (SELECT count(*)::integer FROM catalog),
    'datasets_published', (SELECT count(*)::integer FROM catalog WHERE availability = 'published'),
    'data_owners',        (SELECT count(DISTINCT data_owner)::integer FROM catalog),
    'fresh_within_24h',   (SELECT count(*)::integer FROM catalog
                            WHERE last_success_started_at > now() - interval '24 hours'),
    'columns_withheld',   (SELECT COALESCE(sum(withheld_column_count), 0)::integer FROM catalog),
    'runs_succeeded_7d',  (SELECT succeeded_7d FROM runs),
    'runs_total_7d',      (SELECT total_7d FROM runs)
  ),
  'domains', (
    SELECT COALESCE(json_agg(row_to_json(d) ORDER BY d.sort_order), '[]'::json)
    FROM (
      SELECT dl.key,
             dl.label,
             dl.label_en,
             dl.sort_order,
             count(c.*)::integer AS dataset_count,
             count(c.*) FILTER (WHERE c.availability = 'published')::integer AS published_count
      FROM domain_label AS dl
      LEFT JOIN catalog AS c ON c.domain = dl.key
      GROUP BY dl.key, dl.label, dl.label_en, dl.sort_order
      HAVING count(c.*) > 0
    ) AS d
  ),
  'datasets', (
    SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.title), '[]'::json)
    FROM (
      SELECT c.dataset_key            AS key,
             c.title,
             c.description,
             c.title_en,
             c.description_en,
             c.domain,
             c.availability,
             c.load_mode,
             c.data_owner             AS owner,
             c.source_display_name    AS source,
             c.lawful_basis,
             c.retention_note         AS retention,
             to_char(c.last_success_started_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_success_at,
             c.last_success_rows      AS rows,
             c.column_count,
             c.safe_column_count,
             c.withheld_column_count
      FROM catalog AS c
    ) AS x
  )
);
SQL

if [ ! -s "${temp_file}" ]; then
  rm -f "${temp_file}"
  echo "the query returned nothing; catalogue not written" >&2
  exit 1
fi

# Guard rather than trust. If any of these ever appears the publisher has been
# widened past what the portal is allowed to receive, and the file must not be
# written.
for forbidden in credentials_env_prefix password error_message psu.ac.th lakedb; do
  if grep -qi -- "${forbidden}" "${temp_file}"; then
    rm -f "${temp_file}"
    echo "refusing to publish: output contains '${forbidden}'" >&2
    exit 1
  fi
done

mv "${temp_file}" "${output_file}"
echo "wrote ${output_file} ($(wc -c < "${output_file}" | tr -d ' ') bytes)"
