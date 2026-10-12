/**
 * Everything this service writes goes through here, as parameterised
 * statements against the least-privilege identity_app role. That role has no
 * DELETE on accounts or on the login log: an account is switched off with
 * is_active, and the audit trail is only ever shortened by the retention
 * function, which deletes strictly by age.
 */
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

import type { AppConfig } from './config.js';
import type { DirectoryResult } from './directory.js';

export type LoginOutcome = 'succeeded' | 'denied' | 'failed';
export type LoginReason =
  | 'signed_in'
  | 'signed_out'
  | 'session_expired'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'claims_incomplete'
  | 'directory_unavailable'
  | 'account_disabled'
  | 'invalid_credentials'
  | 'rate_limited';

export interface AccountIdentity {
  subject: string;
  username: string;
  displayName?: string | undefined;
  email?: string | undefined;
}

export type AccessTier = 'none' | 'viewer' | 'viewer_exec' | 'analyst' | 'steward' | 'developer';

export interface Account {
  userId: string;
  /** The PSU directory username. Null for an email-and-password account, which has no PSU Passport identity. */
  username: string | null;
  displayName: string | null;
  email: string | null;
  userType: 'student' | 'staff' | 'unknown';
  campusCode: string | null;
  campusNameTh: string | null;
  facultyNameTh: string | null;
  departmentNameTh: string | null;
  majorNameTh: string | null;
  isActive: boolean;
  /** What this account may read in Trino, granted by an administrator -- see config/platform/008-access-grants.sql and 014-steward-developer-tiers.sql. Never set by this service. */
  accessTier: AccessTier;
  orgUnit: string | null;
}

const accountFromRow = (row: Record<string, unknown>): Account => ({
  userId: String(row.user_id),
  username: (row.psu_username as string | null) ?? null,
  displayName: (row.display_name as string | null) ?? null,
  email: (row.email as string | null) ?? null,
  userType: row.user_type as Account['userType'],
  campusCode: (row.campus_code as string | null) ?? null,
  campusNameTh: (row.campus_name_th as string | null) ?? null,
  facultyNameTh: (row.faculty_name_th as string | null) ?? null,
  departmentNameTh: (row.department_name_th as string | null) ?? null,
  majorNameTh: (row.major_name_th as string | null) ?? null,
  isActive: Boolean(row.is_active),
  accessTier: row.access_tier as AccessTier,
  orgUnit: (row.org_unit as string | null) ?? null,
});

const ACCOUNT_COLUMNS = `user_id, psu_username, display_name, email, user_type,
  campus_code, campus_name_th, faculty_name_th, department_name_th, major_name_th, is_active,
  access_tier, org_unit`;

export class IdentityStore {
  private readonly pool: pg.Pool;
  readonly releases: ReleaseStore;

  constructor(config: AppConfig) {
    this.pool = new pg.Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.releases = new ReleaseStore(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /**
   * Creates the account on first sign-in and refreshes the claim-derived
   * fields afterwards. The directory fields are left alone here: they are
   * written separately, so a gateway outage never blanks an affiliation that
   * was resolved correctly last week.
   */
  async upsertAccount(identity: AccountIdentity): Promise<Account> {
    const result = await this.pool.query(
      `INSERT INTO identity.app_user (subject, psu_username, display_name, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subject) DO UPDATE
         SET psu_username = EXCLUDED.psu_username,
             display_name = COALESCE(EXCLUDED.display_name, identity.app_user.display_name),
             email        = COALESCE(EXCLUDED.email, identity.app_user.email),
             last_login_at = now()
       RETURNING ${ACCOUNT_COLUMNS}`,
      [identity.subject, identity.username, identity.displayName ?? null, identity.email ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('account upsert returned no row');
    }
    return accountFromRow(row);
  }

  /** Records what the gateway answered, including which group it answered as. */
  /**
   * Looks an account up by email for a password sign-in attempt. Returns the
   * stored hash alongside the account so the caller can run bcrypt.compare
   * even when nothing is found -- see verifyPassword's dummy-hash comment for
   * why that matters. The hash never leaves this method for any other reason.
   */
  async findByEmailForPasswordLogin(
    email: string,
  ): Promise<{ account: Account; passwordHash: string | null } | null> {
    const result = await this.pool.query(
      `SELECT ${ACCOUNT_COLUMNS}, password_hash
         FROM identity.app_user
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { account: accountFromRow(row), passwordHash: (row.password_hash as string | null) ?? null };
  }

  /** Marks a successful password sign-in. Directory lookup does not apply here: a password account has no PSU username to resolve. */
  async recordPasswordLogin(userId: string): Promise<Account> {
    const result = await this.pool.query(
      `UPDATE identity.app_user SET last_login_at = now() WHERE user_id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('recordPasswordLogin matched no account');
    }
    return accountFromRow(row);
  }

  async saveDirectory(userId: string, resolved: DirectoryResult): Promise<Account> {
    const result = await this.pool.query(
      `UPDATE identity.app_user
          SET user_type = $2,
              campus_code = COALESCE($3, campus_code),
              campus_name_th = $4,
              faculty_name_th = $5,
              department_name_th = $6,
              major_name_th = $7,
              directory_synced_at = now()
        WHERE user_id = $1
        RETURNING ${ACCOUNT_COLUMNS}`,
      [
        userId,
        resolved.group,
        resolved.record.campusCode ?? null,
        resolved.record.campusNameTh ?? null,
        resolved.record.facultyNameTh ?? null,
        resolved.record.departmentNameTh ?? null,
        resolved.record.majorNameTh ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('directory update matched no account');
    }
    return accountFromRow(row);
  }

  /**
   * Issues a session. The caller gets the token; the database gets its
   * SHA-256, so a dump of this table cannot be replayed as a live session.
   */
  async createSession(userId: string, ttlSeconds: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO identity.user_session (session_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [hashToken(token), userId, ttlSeconds],
    );
    return token;
  }

  /** Returns the account behind a live session, or null. Expired rows never match. */
  async readSession(token: string): Promise<Account | null> {
    const result = await this.pool.query(
      `UPDATE identity.user_session AS s
          SET last_seen_at = now()
         FROM identity.app_user AS u
        WHERE s.session_hash = $1
          AND s.expires_at > now()
          AND u.user_id = s.user_id
        RETURNING ${ACCOUNT_COLUMNS.split(', ').map((column) => `u.${column.trim()}`).join(', ')}`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    return row ? accountFromRow(row) : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM identity.user_session WHERE session_hash = $1', [
      hashToken(token),
    ]);
  }

  /** Access log, not a data log: the outcome and a fixed reason code only. */
  async recordLogin(
    userId: string | null,
    outcome: LoginOutcome,
    reason: LoginReason,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO identity.login_event (user_id, outcome, reason) VALUES ($1, $2, $3)',
      [userId, outcome, reason],
    );
  }

  async purgeExpired(): Promise<void> {
    await this.pool.query('SELECT identity.purge_expired()');
  }

  /**
   * Audit row for a staged upload -- see config/platform/016-upload-log.sql
   * and config/platform/018-upload-text-extraction.sql. `uploadId` is
   * generated by the caller (server.ts), not this column's own default, so
   * the same id can also name the object's directory in RustFS (rustfs.ts's
   * putStagedUpload) -- one id ties the two together.
   */
  async recordUpload(
    uploadId: string,
    userId: string,
    orgUnit: string,
    objectKey: string,
    originalFilename: string,
    sizeBytes: number,
    fileKind: 'csv' | 'pdf' | 'docx',
    extractedTextKey: string | null,
    uploaderNote?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO identity.upload_event
         (upload_id, user_id, org_unit, object_key, original_filename, size_bytes, file_kind, extracted_text_key, uploader_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uploadId, userId, orgUnit, objectKey, originalFilename, sizeBytes, fileKind, extractedTextKey, uploaderNote ?? null],
    );
  }

  async listUploadsForUser(userId: string): Promise<UploadRecord[]> {
    const result = await this.pool.query(
      `SELECT upload_id, user_id, org_unit, original_filename, size_bytes,
              uploaded_at, status, file_kind, reviewed_by_username, reviewed_at,
              target_table, columns_included, columns_excluded, uploader_note, rejection_reason
         FROM identity.upload_event
        WHERE user_id = $1
        ORDER BY uploaded_at DESC
        LIMIT 50`,
      [userId],
    );
    return result.rows.map((row) => ({
      uploadId: row.upload_id,
      userId: row.user_id,
      orgUnit: row.org_unit,
      originalFilename: row.original_filename,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : '',
      status: row.status,
      fileKind: row.file_kind,
      reviewedByUsername: row.reviewed_by_username ?? null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      targetTable: row.target_table ?? null,
      columnsIncluded: row.columns_included !== null ? Number(row.columns_included) : null,
      columnsExcluded: row.columns_excluded !== null ? Number(row.columns_excluded) : null,
      uploaderNote: row.uploader_note ?? null,
      rejectionReason: row.rejection_reason ?? null,
    }));
  }

  async listAllUploadsForReview(): Promise<UploadRecord[]> {
    const result = await this.pool.query(
      `SELECT e.upload_id, e.user_id, e.org_unit, e.object_key, e.original_filename, e.size_bytes,
              e.uploaded_at, e.status, e.file_kind, e.reviewed_by_username, e.reviewed_at,
              e.target_table, e.columns_included, e.columns_excluded, e.extracted_text_key,
              e.uploader_note, e.rejection_reason,
              u.psu_username, u.display_name
         FROM identity.upload_event e
         LEFT JOIN identity.app_user u ON u.user_id = e.user_id
        ORDER BY CASE WHEN e.status = 'pending_review' THEN 0 ELSE 1 END,
                 e.uploaded_at DESC
        LIMIT 100`,
    );
    return result.rows.map((row) => ({
      uploadId: row.upload_id,
      userId: row.user_id,
      orgUnit: row.org_unit,
      objectKey: row.object_key,
      originalFilename: row.original_filename,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : '',
      status: row.status,
      fileKind: row.file_kind,
      reviewedByUsername: row.reviewed_by_username ?? null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      targetTable: row.target_table ?? null,
      columnsIncluded: row.columns_included !== null ? Number(row.columns_included) : null,
      columnsExcluded: row.columns_excluded !== null ? Number(row.columns_excluded) : null,
      extractedTextKey: row.extracted_text_key ?? null,
      uploaderNote: row.uploader_note ?? null,
      rejectionReason: row.rejection_reason ?? null,
      uploaderUsername: row.psu_username ?? null,
      uploaderDisplayName: row.display_name ?? null,
    }));
  }

  async getUploadForReview(uploadId: string): Promise<UploadRecord | null> {
    const result = await this.pool.query(
      `SELECT e.upload_id, e.user_id, e.org_unit, e.object_key, e.original_filename, e.size_bytes,
              e.uploaded_at, e.status, e.file_kind, e.reviewed_by_username, e.reviewed_at,
              e.target_table, e.columns_included, e.columns_excluded, e.extracted_text_key,
              e.uploader_note, e.rejection_reason,
              u.psu_username, u.display_name
         FROM identity.upload_event e
         LEFT JOIN identity.app_user u ON u.user_id = e.user_id
        WHERE e.upload_id = $1`,
      [uploadId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      uploadId: row.upload_id,
      userId: row.user_id,
      orgUnit: row.org_unit,
      objectKey: row.object_key,
      originalFilename: row.original_filename,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : '',
      status: row.status,
      fileKind: row.file_kind,
      reviewedByUsername: row.reviewed_by_username ?? null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      targetTable: row.target_table ?? null,
      columnsIncluded: row.columns_included !== null ? Number(row.columns_included) : null,
      columnsExcluded: row.columns_excluded !== null ? Number(row.columns_excluded) : null,
      extractedTextKey: row.extracted_text_key ?? null,
      uploaderNote: row.uploader_note ?? null,
      rejectionReason: row.rejection_reason ?? null,
      uploaderUsername: row.psu_username ?? null,
      uploaderDisplayName: row.display_name ?? null,
    };
  }

  async recordReviewDecision(
    uploadId: string,
    status: 'registered' | 'rejected',
    reviewer: string,
    targetTable?: string | null,
    colsIncluded?: number | null,
    colsExcluded?: number | null,
    rejectionReason?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity.upload_event
          SET status = $2,
              reviewed_by_username = $3,
              reviewed_at = now(),
              target_table = $4,
              columns_included = $5,
              columns_excluded = $6,
              rejection_reason = $7
        WHERE upload_id = $1`,
      [
        uploadId,
        status,
        reviewer,
        targetTable ?? null,
        colsIncluded !== undefined ? colsIncluded : null,
        colsExcluded !== undefined ? colsExcluded : null,
        rejectionReason ?? null,
      ],
    );
  }
}

export interface UploadRecord {
  uploadId: string;
  userId: string;
  orgUnit: string;
  objectKey?: string;
  originalFilename: string;
  sizeBytes: number;
  uploadedAt: string;
  status: 'pending_review' | 'registered' | 'rejected';
  fileKind: 'csv' | 'pdf' | 'docx';
  reviewedByUsername: string | null;
  reviewedAt: string | null;
  targetTable: string | null;
  columnsIncluded: number | null;
  columnsExcluded: number | null;
  extractedTextKey?: string | null;
  uploaderNote?: string | null;
  rejectionReason?: string | null;
  uploaderUsername?: string | null;
  uploaderDisplayName?: string | null;
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export type ReleaseStatus = 'requested' | 'approved' | 'published' | 'failed' | 'rejected';
export type ReleaseAccessLevel = 'university' | 'restricted';
export type ReleaseCadence = 'manual' | 'daily' | 'weekly' | 'monthly';

export interface ReleaseRequestInput {
  tableName: string;
  titleTh: string;
  titleEn: string | null;
  descriptionTh: string | null;
  descriptionEn: string | null;
  domain: string | null;
  tags: string[];
  ownerOrgUnit: string;
  accessLevel: ReleaseAccessLevel;
  refreshCadence: ReleaseCadence;
  changelog: string | null;
}

export interface ReleaseRecord extends ReleaseRequestInput {
  releaseId: string;
  version: number;
  status: ReleaseStatus;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  sourceSnapshotId: string | null;
  publishedSnapshotId: string | null;
  rowCount: number | null;
  publishedAt: string | null;
  failureCode: string | null;
}

/** What the public catalogue may show about a published release: no account, no snapshot, no failure detail. */
export interface PublishedReleaseSummary {
  tableName: string;
  version: number;
  titleTh: string;
  titleEn: string | null;
  descriptionTh: string | null;
  descriptionEn: string | null;
  domain: string | null;
  tags: string[];
  ownerOrgUnit: string;
  accessLevel: ReleaseAccessLevel;
  refreshCadence: ReleaseCadence;
  rowCount: number | null;
  publishedAt: string | null;
}

const isoOrNull = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;

const RELEASE_COLUMNS = `r.release_id, r.table_name, r.version, r.title_th, r.title_en,
  r.description_th, r.description_en, r.domain, r.tags, r.owner_org_unit, r.access_level,
  r.refresh_cadence, r.changelog, r.status, r.requested_by, r.requested_at, r.decided_by,
  r.decided_at, r.rejection_reason, r.source_snapshot_id, r.published_snapshot_id,
  r.row_count, r.published_at, r.failure_code,
  rq.display_name AS requested_by_name, dc.display_name AS decided_by_name`;

const RELEASE_FROM = `identity.dataset_release AS r
  JOIN identity.app_user AS rq ON rq.user_id = r.requested_by
  LEFT JOIN identity.app_user AS dc ON dc.user_id = r.decided_by`;

const releaseFromRow = (row: Record<string, unknown>): ReleaseRecord => ({
  releaseId: String(row.release_id),
  tableName: String(row.table_name),
  version: Number(row.version),
  titleTh: String(row.title_th),
  titleEn: (row.title_en as string | null) ?? null,
  descriptionTh: (row.description_th as string | null) ?? null,
  descriptionEn: (row.description_en as string | null) ?? null,
  domain: (row.domain as string | null) ?? null,
  tags: (row.tags as string[] | null) ?? [],
  ownerOrgUnit: String(row.owner_org_unit),
  accessLevel: row.access_level as ReleaseAccessLevel,
  refreshCadence: row.refresh_cadence as ReleaseCadence,
  changelog: (row.changelog as string | null) ?? null,
  status: row.status as ReleaseStatus,
  requestedBy: String(row.requested_by),
  requestedByName: (row.requested_by_name as string | null) ?? null,
  requestedAt: isoOrNull(row.requested_at) ?? '',
  decidedBy: (row.decided_by as string | null) ?? null,
  decidedByName: (row.decided_by_name as string | null) ?? null,
  decidedAt: isoOrNull(row.decided_at),
  rejectionReason: (row.rejection_reason as string | null) ?? null,
  // bigint arrives from pg as a string and stays one: an Iceberg snapshot id
  // does not fit in a JavaScript number.
  sourceSnapshotId: (row.source_snapshot_id as string | null) ?? null,
  publishedSnapshotId: (row.published_snapshot_id as string | null) ?? null,
  rowCount: row.row_count !== null && row.row_count !== undefined ? Number(row.row_count) : null,
  publishedAt: isoOrNull(row.published_at),
  failureCode: (row.failure_code as string | null) ?? null,
});

/** Raised when a request collides with an open one for the same table. */
export class ReleaseConflictError extends Error {}

/**
 * Dataset releases -- see config/platform/021-dataset-release.sql. Shares the
 * identity store's pool and role; identity_app holds column-level grants on
 * the table, so this cannot rewrite who asked or what was asked for.
 */
export class ReleaseStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The version is the next one for the table, computed in the same statement.
   * Two requests racing for the same number are caught by the unique
   * constraint, and one open request per table by the partial unique index,
   * so either collision surfaces as ReleaseConflictError rather than a 500.
   */
  async create(input: ReleaseRequestInput, requestedBy: string): Promise<ReleaseRecord> {
    let releaseId: string;
    try {
      const result = await this.pool.query(
        `INSERT INTO identity.dataset_release
           (table_name, version, title_th, title_en, description_th, description_en, domain, tags,
            owner_org_unit, access_level, refresh_cadence, changelog, requested_by)
         SELECT $1, COALESCE(max(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
           FROM identity.dataset_release
          WHERE table_name = $1
         RETURNING release_id`,
        [
          input.tableName, input.titleTh, input.titleEn, input.descriptionTh, input.descriptionEn,
          input.domain, input.tags, input.ownerOrgUnit, input.accessLevel, input.refreshCadence,
          input.changelog, requestedBy,
        ],
      );
      releaseId = String(result.rows[0]?.release_id);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ReleaseConflictError('an open release already exists for this table');
      }
      throw error;
    }
    const created = await this.get(releaseId);
    if (!created) {
      throw new Error('release insert returned no row');
    }
    return created;
  }

  async get(releaseId: string): Promise<ReleaseRecord | null> {
    const result = await this.pool.query(
      `SELECT ${RELEASE_COLUMNS} FROM ${RELEASE_FROM} WHERE r.release_id = $1`,
      [releaseId],
    );
    const row = result.rows[0];
    return row ? releaseFromRow(row) : null;
  }

  /** Open requests first, then the most recent. `orgUnit` narrows to one data owner's releases. */
  async list(orgUnit: string | null): Promise<ReleaseRecord[]> {
    const result = await this.pool.query(
      `SELECT ${RELEASE_COLUMNS} FROM ${RELEASE_FROM}
        WHERE $1::text IS NULL OR r.owner_org_unit = $1
        ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                 r.requested_at DESC
        LIMIT 200`,
      [orgUnit],
    );
    return result.rows.map(releaseFromRow);
  }

  /**
   * Moves a request to 'approved' only while it is still 'requested' and the
   * decider is not the requester. The conditional UPDATE is the lock: of two
   * approvers clicking at once, exactly one gets the row back.
   */
  async claimForApproval(releaseId: string, decidedBy: string): Promise<ReleaseRecord | null> {
    const result = await this.pool.query(
      `UPDATE identity.dataset_release
          SET status = 'approved', decided_by = $2, decided_at = now()
        WHERE release_id = $1 AND status = 'requested' AND requested_by <> $2
        RETURNING release_id`,
      [releaseId, decidedBy],
    );
    return result.rowCount ? this.get(releaseId) : null;
  }

  async markPublished(
    releaseId: string,
    sourceSnapshotId: string,
    publishedSnapshotId: string,
    rowCount: number | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity.dataset_release
          SET status = 'published', source_snapshot_id = $2, published_snapshot_id = $3,
              row_count = $4, published_at = now(), failure_code = NULL
        WHERE release_id = $1 AND status = 'approved'`,
      [releaseId, sourceSnapshotId, publishedSnapshotId, rowCount],
    );
  }

  async markFailed(releaseId: string, failureCode: string, sourceSnapshotId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE identity.dataset_release
          SET status = 'failed', failure_code = $2, source_snapshot_id = $3
        WHERE release_id = $1 AND status = 'approved'`,
      [releaseId, failureCode, sourceSnapshotId],
    );
  }

  /**
   * A release copies after the approval response has gone, inside this
   * process. One left 'approved' at start-up was cut off by a restart, and
   * would otherwise hold the table's one open slot forever.
   */
  async failInterrupted(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE identity.dataset_release
          SET status = 'failed', failure_code = 'interrupted'
        WHERE status = 'approved'`,
    );
    return result.rowCount ?? 0;
  }

  async reject(releaseId: string, decidedBy: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE identity.dataset_release
          SET status = 'rejected', decided_by = $2, decided_at = now(), rejection_reason = $3
        WHERE release_id = $1 AND status = 'requested' AND requested_by <> $2`,
      [releaseId, decidedBy, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listPublished(): Promise<PublishedReleaseSummary[]> {
    const result = await this.pool.query(
      `SELECT table_name, version, title_th, title_en, description_th, description_en, domain,
              tags, owner_org_unit, access_level, refresh_cadence, row_count, published_at
         FROM identity.v_published_release
        ORDER BY title_th`,
    );
    return result.rows.map((row) => ({
      tableName: String(row.table_name),
      version: Number(row.version),
      titleTh: String(row.title_th),
      titleEn: row.title_en ?? null,
      descriptionTh: row.description_th ?? null,
      descriptionEn: row.description_en ?? null,
      domain: row.domain ?? null,
      tags: row.tags ?? [],
      ownerOrgUnit: String(row.owner_org_unit),
      accessLevel: row.access_level,
      refreshCadence: row.refresh_cadence,
      rowCount: row.row_count !== null ? Number(row.row_count) : null,
      publishedAt: isoOrNull(row.published_at),
    }));
  }
}
