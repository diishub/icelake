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
  | 'account_disabled';

export interface AccountIdentity {
  subject: string;
  username: string;
  displayName?: string | undefined;
  email?: string | undefined;
}

export interface Account {
  userId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  userType: 'student' | 'staff' | 'unknown';
  campusCode: string | null;
  campusNameTh: string | null;
  facultyNameTh: string | null;
  departmentNameTh: string | null;
  majorNameTh: string | null;
  isActive: boolean;
}

const accountFromRow = (row: Record<string, unknown>): Account => ({
  userId: String(row.user_id),
  username: String(row.psu_username),
  displayName: (row.display_name as string | null) ?? null,
  email: (row.email as string | null) ?? null,
  userType: row.user_type as Account['userType'],
  campusCode: (row.campus_code as string | null) ?? null,
  campusNameTh: (row.campus_name_th as string | null) ?? null,
  facultyNameTh: (row.faculty_name_th as string | null) ?? null,
  departmentNameTh: (row.department_name_th as string | null) ?? null,
  majorNameTh: (row.major_name_th as string | null) ?? null,
  isActive: Boolean(row.is_active),
});

const ACCOUNT_COLUMNS = `user_id, psu_username, display_name, email, user_type,
  campus_code, campus_name_th, faculty_name_th, department_name_th, major_name_th, is_active`;

export class IdentityStore {
  private readonly pool: pg.Pool;

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
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
