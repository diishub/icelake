import https from 'node:https';

export interface TrinoConfig {
  endpoint: string;
  username: string;
  password: string;
}

export interface TrinoColumn {
  name: string;
  type: string;
}

export interface TrinoResult {
  columns: TrinoColumn[];
  rows: unknown[][];
}

export interface TrinoQueryOptions {
  /** Whole-statement budget, polling included. The query is cancelled when it runs out. */
  timeoutMs?: number;
  /** Rows beyond this fail the call rather than growing this process's memory without bound. */
  maxRows?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ROWS = 10_000;

interface TrinoResponse {
  nextUri?: string;
  columns?: TrinoColumn[];
  data?: unknown[][];
  error?: { message?: string; errorName?: string };
}

function trinoRequest(
  config: TrinoConfig,
  url: URL,
  method: 'POST' | 'GET' | 'DELETE',
  body: string | null,
  timeoutMs: number,
): Promise<TrinoResponse> {
  const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        // Trino's certificate is self-signed in this stack (trino-tls-setup in
        // compose.yaml); verifying it needs that keystore's CA distributed to
        // this container, which is perimeter work, not this.
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          'X-Trino-User': config.username,
          Authorization: authHeader,
          ...(body !== null ? { 'Content-Type': 'text/plain' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (method === 'DELETE') {
            resolve({});
            return;
          }
          // Every response is checked, not only the first: a 503 while
          // polling is Trino shedding load and must not read as "done".
          if (status < 200 || status >= 300) {
            reject(new Error(`Trino HTTP ${status}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as TrinoResponse);
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Trino request timed out')));
    req.on('error', reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Runs one statement to completion and returns every row. Bounded in both time
 * and size: an unbounded read here would let one large table take this whole
 * sign-in service down with it.
 */
export async function queryTrino(
  config: TrinoConfig,
  statement: string,
  options: TrinoQueryOptions = {},
): Promise<TrinoResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  let state = await trinoRequest(config, new URL('/v1/statement', config.endpoint), 'POST', statement, remaining());
  let columns: TrinoColumn[] = [];
  const rows: unknown[][] = [];

  for (;;) {
    if (state.error) {
      throw new Error(state.error.message || state.error.errorName || 'Trino execution error');
    }
    if (state.columns && columns.length === 0) {
      columns = state.columns.map((c) => ({ name: c.name, type: c.type }));
    }
    if (Array.isArray(state.data)) {
      rows.push(...state.data);
    }
    const tooLarge = rows.length > maxRows;
    if (!state.nextUri && !tooLarge) {
      return { columns, rows };
    }

    if (tooLarge || Date.now() >= deadline) {
      // Best effort: tell Trino to stop rather than leave the query running
      // for a caller that has already given up on it.
      if (state.nextUri) {
        await trinoRequest(config, new URL(state.nextUri), 'DELETE', null, 5_000).catch(() => undefined);
      }
      throw new Error(tooLarge ? `Trino result exceeded ${maxRows} rows` : 'Trino query timed out');
    }
    state = await trinoRequest(config, new URL(state.nextUri!), 'GET', null, remaining());
  }
}

/** For statements run for their effect, where only the last page was ever read. */
export async function executeTrinoSql(
  config: TrinoConfig,
  statement: string,
): Promise<{ data?: unknown[][] }> {
  const result = await queryTrino(config, statement);
  return { data: result.rows };
}

export interface ReviewColumn {
  name: string;
  type: string;
  classification: 'public' | 'internal' | 'sensitive';
}

export interface BridgeParams {
  uploadId: string;
  orgUnit: string;
  tableSuffix: string;
  bucket: string;
  objectKey: string;
  uploadedBy: string;
  columns: ReviewColumn[];
}

/** A reviewer's choice the bridge cannot load; `code` is safe to send back. */
export class BridgeInputError extends Error {
  constructor(
    readonly code: 'invalid_table_suffix' | 'invalid_column_name' | 'unsupported_column_type' | 'no_public_column',
    message: string,
  ) {
    super(message);
  }
}

export interface BridgePlan {
  publicColumns: ReviewColumn[];
  excludedCount: number;
}

/**
 * Checks the reviewer's table name and columns without touching Trino, so the
 * approve call can refuse bad input before it claims the upload and answers.
 */
export function planCsvBridge(params: Pick<BridgeParams, 'tableSuffix' | 'columns'>): BridgePlan {
  const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
  if (!IDENTIFIER.test(params.tableSuffix)) {
    throw new BridgeInputError('invalid_table_suffix', `table_suffix must match ${IDENTIFIER}`);
  }

  const ALLOWED_TYPES = new Set(['VARCHAR', 'BIGINT', 'INTEGER', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP']);
  const publicColumns: ReviewColumn[] = [];
  let excludedCount = 0;

  for (const col of params.columns) {
    if (typeof col?.name !== 'string' || !IDENTIFIER.test(col.name)) {
      throw new BridgeInputError('invalid_column_name', `Column name must match ${IDENTIFIER}`);
    }
    if (typeof col.type !== 'string' || !ALLOWED_TYPES.has(col.type.toUpperCase())) {
      throw new BridgeInputError('unsupported_column_type', `Column type of ${col.name} is not supported`);
    }
    if (col.classification === 'public') {
      publicColumns.push({ name: col.name, type: col.type.toUpperCase(), classification: 'public' });
    } else {
      excludedCount++;
    }
  }

  if (publicColumns.length === 0) {
    throw new BridgeInputError(
      'no_public_column',
      'No column classified as public; at least one public column is required to create a table',
    );
  }
  return { publicColumns, excludedCount };
}

export async function bridgeCsvToIceberg(
  config: TrinoConfig,
  params: BridgeParams,
): Promise<{ targetTable: string; columnsIncluded: number; columnsExcluded: number }> {
  const { publicColumns, excludedCount } = planCsvBridge(params);

  const quote = (name: string) => `"${name}"`;
  const targetTable = `steward_${params.orgUnit}_${params.tableSuffix}`;
  const stagingTable = `stg_${params.uploadId.replace(/-/g, '')}`;
  const qualifiedTarget = `polaris.raw."${targetTable}"`;
  const qualifiedStaging = `hive.raw_staging."${stagingTable}"`;

  const stagingDir = params.objectKey.substring(0, params.objectKey.lastIndexOf('/') + 1);
  const stagingColumnsSql = params.columns.map((c) => `${quote(c.name)} VARCHAR`).join(', ');
  const targetColumnsSql = publicColumns.map((c) => `${quote(c.name)} ${c.type}`).join(', ');
  const insertColumnsSql = publicColumns.map((c) => quote(c.name)).join(', ');
  const selectListSql = publicColumns
    .map((c) => `CAST(NULLIF(${quote(c.name)}, '') AS ${c.type})`)
    .join(', ');

  // 1. Create target Iceberg table if not exists
  await executeTrinoSql(
    config,
    `CREATE TABLE IF NOT EXISTS ${qualifiedTarget} (${targetColumnsSql}, "_ingested_at" TIMESTAMP(6), "_source_system" VARCHAR, "_uploaded_by" VARCHAR, "_org_unit" VARCHAR, "_run_id" VARCHAR) WITH (partitioning = ARRAY['day(_ingested_at)'])`,
  );

  try {
    // 2. Create staging table pointer to S3 directory
    await executeTrinoSql(
      config,
      `CREATE TABLE ${qualifiedStaging} (${stagingColumnsSql}) WITH (external_location = 's3://${params.bucket}/${stagingDir}', format = 'CSV', skip_header_line_count = 1)`,
    );

    // 3. Insert public columns into target
    await executeTrinoSql(
      config,
      `INSERT INTO ${qualifiedTarget} (${insertColumnsSql}, "_ingested_at", "_source_system", "_uploaded_by", "_org_unit", "_run_id")
       SELECT ${selectListSql}, now(), 'portal-review', '${params.uploadedBy.replace(/'/g, "''")}', '${params.orgUnit.replace(/'/g, "''")}', '${params.uploadId}'
         FROM ${qualifiedStaging}`,
    );
  } finally {
    // 4. Always clean up staging pointer
    try {
      await executeTrinoSql(config, `DROP TABLE IF EXISTS ${qualifiedStaging}`);
    } catch (e) {
      console.warn(`[trino] drop staging table failed:`, e);
    }
  }

  return {
    targetTable,
    columnsIncluded: publicColumns.length,
    columnsExcluded: excludedCount,
  };
}
