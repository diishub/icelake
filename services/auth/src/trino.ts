import https from 'node:https';

export interface TrinoConfig {
  endpoint: string;
  username: string;
  password: string;
}

export async function executeTrinoSql(
  config: TrinoConfig,
  statement: string,
): Promise<{ data?: any[][]; error?: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/statement', config.endpoint);
    const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');

    function postStatement() {
      const req = https.request(
        url,
        {
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'X-Trino-User': config.username,
            'Authorization': authHeader,
            'Content-Type': 'text/plain',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                return reject(new Error(`Trino HTTP ${res.statusCode}: ${body}`));
              }
              const parsed = JSON.parse(body);
              pollNext(parsed);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(statement);
      req.end();
    }

    function pollNext(state: any) {
      if (state.error) {
        return reject(new Error(state.error.message || 'Trino execution error'));
      }
      if (!state.nextUri) {
        return resolve({ data: state.data });
      }
      const nextUrl = new URL(state.nextUri);
      const req = https.request(
        nextUrl,
        {
          method: 'GET',
          rejectUnauthorized: false,
          headers: {
            'X-Trino-User': config.username,
            'Authorization': authHeader,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              pollNext(parsed);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
    }

    postStatement();
  });
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

export async function bridgeCsvToIceberg(
  config: TrinoConfig,
  params: BridgeParams,
): Promise<{ targetTable: string; columnsIncluded: number; columnsExcluded: number }> {
  const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
  if (!IDENTIFIER.test(params.tableSuffix)) {
    throw new Error(`table_suffix must match ${IDENTIFIER}`);
  }

  const ALLOWED_TYPES = new Set(['VARCHAR', 'BIGINT', 'INTEGER', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP']);
  const publicColumns: ReviewColumn[] = [];
  let excludedCount = 0;

  for (const col of params.columns) {
    if (!IDENTIFIER.test(col.name)) {
      throw new Error(`Column name ${col.name} must match ${IDENTIFIER}`);
    }
    if (!ALLOWED_TYPES.has(col.type.toUpperCase())) {
      throw new Error(`Column type ${col.type} is not supported`);
    }
    if (col.classification === 'public') {
      publicColumns.push({ name: col.name, type: col.type.toUpperCase(), classification: 'public' });
    } else {
      excludedCount++;
    }
  }

  if (publicColumns.length === 0) {
    throw new Error('No column classified as public; at least one public column is required to create a table');
  }

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
