/**
 * The Trino half of a dataset release (config/platform/021-dataset-release.sql).
 *
 * Runs as the publisher identity, which OPA lets read curated in full and
 * write published, and nothing else. A release copies one pinned curated
 * snapshot into a published table of the same name; the name is kept so an
 * org_scoped_tables.json entry row-filters the published copy exactly as it
 * did the curated one.
 */
import { queryTrino } from './trino.js';
import type { TrinoConfig } from './trino.js';

/** Interpolated into SQL below, so nothing else may reach a statement. Mirrors the database CHECK. */
export const TABLE_NAME = /^[a-z][a-z0-9_]{0,127}$/;

export interface CuratedColumn {
  name: string;
  type: string;
}

export interface CuratedPreview {
  columns: CuratedColumn[];
  rowCount: number;
}

export interface PublishOutcome {
  sourceSnapshotId: string;
  publishedSnapshotId: string;
  rowCount: number | null;
}

/** A fixed code for the release row; the Trino error text itself stays in the log. */
export class PublishError extends Error {
  constructor(
    readonly code: 'source_not_found' | 'source_has_no_snapshot' | 'copy_failed' | 'snapshot_read_failed',
    readonly sourceSnapshotId: string | null,
    cause: unknown,
  ) {
    super(code, { cause });
  }
}

function assertTableName(tableName: string): void {
  if (!TABLE_NAME.test(tableName)) {
    throw new Error(`table name must match ${TABLE_NAME}`);
  }
}

/** Base tables only: a view has no snapshot to pin, so it cannot be released. */
export async function listCuratedTables(config: TrinoConfig): Promise<string[]> {
  const result = await queryTrino(
    config,
    `SELECT table_name FROM polaris.information_schema.tables
      WHERE table_schema = 'curated' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    { timeoutMs: 30_000, maxRows: 5_000 },
  );
  return result.rows.map((row) => String(row[0])).filter((name) => TABLE_NAME.test(name));
}

/**
 * Column names and types and a row count -- deliberately no sample rows. The
 * publisher reads without a row filter, and the steward approving a release
 * would otherwise see other org units' rows through this preview.
 */
export async function previewCuratedTable(config: TrinoConfig, tableName: string): Promise<CuratedPreview | null> {
  assertTableName(tableName);
  const columns = await queryTrino(
    config,
    `SELECT column_name, data_type FROM polaris.information_schema.columns
      WHERE table_schema = 'curated' AND table_name = '${tableName}'
      ORDER BY ordinal_position`,
    { timeoutMs: 30_000, maxRows: 2_000 },
  );
  if (columns.rows.length === 0) {
    return null;
  }
  const count = await queryTrino(config, `SELECT count(*) FROM polaris.curated."${tableName}"`, {
    timeoutMs: 60_000,
    maxRows: 1,
  });
  return {
    columns: columns.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) })),
    rowCount: Number(count.rows[0]?.[0] ?? 0),
  };
}

/**
 * The newest snapshot id, as a string: Trino would send a bigint as a JSON
 * number, and an Iceberg snapshot id loses digits as a JavaScript number.
 */
async function latestSnapshotId(config: TrinoConfig, schema: 'curated' | 'published', tableName: string): Promise<string | null> {
  const result = await queryTrino(
    config,
    `SELECT CAST(snapshot_id AS varchar) FROM polaris.${schema}."${tableName}$snapshots"
      ORDER BY committed_at DESC LIMIT 1`,
    { timeoutMs: 30_000, maxRows: 1 },
  );
  const value = result.rows[0]?.[0];
  return typeof value === 'string' && /^-?\d+$/.test(value) ? value : null;
}

export async function publishCuratedTable(config: TrinoConfig, tableName: string): Promise<PublishOutcome> {
  assertTableName(tableName);

  let sourceSnapshotId: string | null;
  try {
    sourceSnapshotId = await latestSnapshotId(config, 'curated', tableName);
  } catch (error) {
    throw new PublishError('source_not_found', null, error);
  }
  if (!sourceSnapshotId) {
    throw new PublishError('source_has_no_snapshot', null, null);
  }

  let rowCount: number | null = null;
  try {
    // OR REPLACE keeps the published table's history, so the previous release
    // stays readable at its own snapshot until expiry removes it.
    const result = await queryTrino(
      config,
      `CREATE OR REPLACE TABLE polaris.published."${tableName}" AS
       SELECT * FROM polaris.curated."${tableName}" FOR VERSION AS OF ${sourceSnapshotId}`,
      { timeoutMs: 10 * 60_000, maxRows: 1 },
    );
    const written = result.rows[0]?.[0];
    rowCount = typeof written === 'number' ? written : null;
  } catch (error) {
    throw new PublishError('copy_failed', sourceSnapshotId, error);
  }

  let publishedSnapshotId: string | null;
  try {
    publishedSnapshotId = await latestSnapshotId(config, 'published', tableName);
  } catch (error) {
    throw new PublishError('snapshot_read_failed', sourceSnapshotId, error);
  }
  if (!publishedSnapshotId) {
    throw new PublishError('snapshot_read_failed', sourceSnapshotId, null);
  }

  return { sourceSnapshotId, publishedSnapshotId, rowCount };
}
