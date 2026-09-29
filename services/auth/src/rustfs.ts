/**
 * One thing only: put a steward's uploaded file into RustFS staging. Nothing
 * here reads a table, classifies a column, or touches Iceberg -- turning a
 * staged upload into a registered, classified, publishable table stays a
 * platform-team action via the existing ingestion registry (README §6.8),
 * not something this module does automatically. See
 * config/platform/016-upload-log.sql for why: an arbitrary uploaded file has
 * had no human column-classification/lawful-basis review yet.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export interface RustfsConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface StagedUpload {
  objectKey: string;
  sizeBytes: number;
}

function client(config: RustfsConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

/**
 * `orgUnit` and `originalFilename` have already been validated by the caller
 * (services/auth/src/server.ts) -- this function trusts its inputs, it does
 * not re-check them.
 *
 * `uploadId` names the object's own directory
 * (`staging/uploads/<orgUnit>/<uploadId>/<filename>`), not just a filename
 * prefix -- a review tool bridges this file into Trino via an
 * `external_location` pointed at that directory, which reads every object in
 * it. One upload per directory is what keeps that scoped to the single file
 * being reviewed instead of every upload a unit has ever made. The caller
 * (server.ts) generates this id and uses the same value for
 * `identity.upload_event.upload_id`, so the two can always be found from
 * each other.
 */
export async function putStagedUpload(
  config: RustfsConfig,
  orgUnit: string,
  uploadId: string,
  originalFilename: string,
  body: Buffer,
): Promise<StagedUpload> {
  const objectKey = `staging/uploads/${orgUnit}/${uploadId}/${originalFilename}`;
  await putObject(config, objectKey, body, 'application/octet-stream');
  return { objectKey, sizeBytes: body.byteLength };
}

/**
 * A plain PUT to an arbitrary key -- used to stage a pdf/docx upload's
 * extracted text (services/auth/src/textExtract.ts) as a sibling object next
 * to the original file, under the same upload directory `putStagedUpload`
 * already created.
 */
export async function putObject(
  config: RustfsConfig,
  objectKey: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  const c = client(config);
  try {
    await c.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  } finally {
    c.destroy();
  }
}

export async function getObject(
  config: RustfsConfig,
  objectKey: string,
  byteLimit?: number,
): Promise<Buffer> {
  const c = client(config);
  try {
    const res = await c.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        Range: byteLimit ? `bytes=0-${byteLimit}` : undefined,
      }),
    );
    if (!res.Body) {
      return Buffer.alloc(0);
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as any) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    c.destroy();
  }
}
