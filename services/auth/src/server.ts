/**
 * Sign-in for the PSU Data Hub portal.
 *
 * The portal itself is static files behind nginx, which cannot hold a client
 * secret or exchange an authorization code, so this service exists to do those
 * two things and nothing else. nginx proxies /auth/* here; everything else it
 * serves from disk.
 *
 * Two independent sign-in methods share one session mechanism:
 *   - PSU Passport (OpenID Connect), only when OIDC_ISSUER/CLIENT_ID/SECRET
 *     are set. Without them this service still starts -- see config.ts -- and
 *     /auth/login, /auth/callback answer 503 rather than taking the whole
 *     service down.
 *   - Email and password, against identity.app_user.password_hash. Accounts
 *     are created by an administrator (scripts/create-password-account.sh);
 *     there is no route here that writes one.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import Busboy from 'busboy';

import { readConfig } from './config.js';
import { resolveDirectory } from './directory.js';
import { OidcProvider } from './oidc.js';
import { LoginRateLimiter, verifyPassword } from './password.js';
import { IdentityStore } from './store.js';
import { mintDashboardGuestToken } from './supersetEmbed.js';
import { putStagedUpload, putObject, getObject } from './rustfs.js';
import { bridgeCsvToIceberg } from './trino.js';
import type { ReviewColumn } from './trino.js';
import { extractPlainText } from './textExtract.js';
import {
  clearCookie, readCookies, readJsonBody, safeNextPath, sendJson, sendRedirect, setCookie,
} from './http.js';

import type { Account, AccessTier } from './store.js';

const OIDC_HANDLE_COOKIE = 'psu_hub_login';

const config = readConfig();
const store = new IdentityStore(config);
const rateLimiter = new LoginRateLimiter(
  config.passwordLogin.maxAttemptsPerWindow,
  config.passwordLogin.windowSeconds,
);

/** What the portal is told about the signed-in person, and no more. */
const publicProfile = (account: Account) => ({
  // A password account has no PSU username; the display name is required at
  // creation time for exactly this reason. See scripts/create-password-account.sh.
  username: account.username,
  displayName: account.displayName,
  userType: account.userType,
  campusNameTh: account.campusNameTh,
  facultyNameTh: account.facultyNameTh,
  departmentNameTh: account.departmentNameTh,
  // Drives role-specific portal rendering (portal/app.js). Not a secret -- it
  // only ever reaches the account's own signed-in browser -- but it is still
  // just a display hint: every real permission check happens again in Trino
  // via OPA, and server-side here for the embed/upload routes below.
  accessTier: account.accessTier,
  orgUnit: account.orgUnit,
});

async function establishSession(res: ServerResponse, userId: string): Promise<void> {
  const token = await store.createSession(userId, config.session.ttlSeconds);
  setCookie(res, config.session.cookieName, token, {
    maxAgeSeconds: config.session.ttlSeconds,
    secure: config.session.secure,
  });
}

async function completeLogin(
  oidc: OidcProvider,
  url: URL,
  loginHandle: string | undefined,
  res: ServerResponse,
): Promise<void> {
  clearCookie(res, OIDC_HANDLE_COOKIE, config.session.secure);

  const pending = oidc.take(loginHandle);
  if (!pending) {
    // No pending login means a replayed, forged or expired callback.
    await store.recordLogin(null, 'denied', 'state_mismatch');
    sendJson(res, 400, { error: 'login_expired' });
    return;
  }

  let claims;
  try {
    claims = await oidc.complete(url, pending);
  } catch (error) {
    console.error('[auth] token exchange failed', error);
    await store.recordLogin(null, 'failed', 'token_exchange_failed');
    sendJson(res, 502, { error: 'login_failed' });
    return;
  }

  const username = claims.username?.split('@')[0]?.toLowerCase();
  if (!username) {
    await store.recordLogin(null, 'denied', 'claims_incomplete');
    sendJson(res, 403, { error: 'login_failed' });
    return;
  }

  const account = await store.upsertAccount({
    subject: claims.subject,
    username,
    displayName: claims.displayName,
    email: claims.email,
  });

  if (!account.isActive) {
    await store.recordLogin(account.userId, 'denied', 'account_disabled');
    sendJson(res, 403, { error: 'account_disabled' });
    return;
  }

  // The directory lookup decides which group the person is in, so it runs
  // before the session is issued rather than in the background: the portal must
  // never show a signed-in person as a group the gateway did not confirm. A
  // gateway outage leaves user_type as it was -- 'unknown' on a first sign-in
  // -- and the portal treats that as no extra access.
  let resolved = account;
  try {
    const directory = await resolveDirectory(
      username,
      config,
      claims.campusCode,
      account.campusCode ?? undefined,
    );
    if (directory) {
      resolved = await store.saveDirectory(account.userId, directory);
    } else {
      await store.recordLogin(account.userId, 'succeeded', 'directory_unavailable');
    }
  } catch (error) {
    console.error('[auth] directory lookup failed', error);
    await store.recordLogin(account.userId, 'succeeded', 'directory_unavailable');
  }

  await establishSession(res, resolved.userId);
  await store.recordLogin(resolved.userId, 'succeeded', 'signed_in');
  sendRedirect(res, pending.next);
}

interface PasswordLoginBody {
  email?: unknown;
  password?: unknown;
  next?: unknown;
}

/**
 * Email-and-password sign-in. A JSON endpoint rather than a redirecting form
 * post: the login page stays in control of showing its own error state
 * without a full navigation, the same way the OIDC path's failures are
 * reported back to a page rather than to a bare error document.
 *
 * Every failure path -- unknown email, wrong password, disabled account,
 * PSU-Passport-only account -- returns the same generic message and runs a
 * bcrypt comparison of equal cost, so neither the wording nor the timing of
 * the response tells a caller which case they hit.
 */
async function passwordLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<PasswordLoginBody>(req);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const next = safeNextPath(typeof body?.next === 'string' ? body.next : null);

  if (!email || !password) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }

  const limiterKey = email.toLowerCase();
  const limit = rateLimiter.check(limiterKey);
  if (!limit.allowed) {
    await store.recordLogin(null, 'denied', 'rate_limited');
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    sendJson(res, 429, { error: 'too_many_attempts', retryAfterSeconds: limit.retryAfterSeconds });
    return;
  }

  const found = await store.findByEmailForPasswordLogin(email);
  const passwordMatches = await verifyPassword(password, found?.passwordHash);

  if (!found || !passwordMatches) {
    rateLimiter.recordFailure(limiterKey);
    await store.recordLogin(found?.account.userId ?? null, 'denied', 'invalid_credentials');
    sendJson(res, 401, { error: 'invalid_credentials' });
    return;
  }

  if (!found.account.isActive) {
    rateLimiter.recordFailure(limiterKey);
    await store.recordLogin(found.account.userId, 'denied', 'account_disabled');
    sendJson(res, 403, { error: 'account_disabled' });
    return;
  }

  rateLimiter.clear(limiterKey);
  const account = await store.recordPasswordLogin(found.account.userId);
  await establishSession(res, account.userId);
  await store.recordLogin(account.userId, 'succeeded', 'signed_in');
  sendJson(res, 200, { ok: true, next, user: publicProfile(account) });
}

/** Reads the session cookie and returns the live account, or null if signed out. */
async function requireAccount(cookies: Map<string, string>): Promise<Account | null> {
  const token = cookies.get(config.session.cookieName);
  const account = token ? await store.readSession(token) : null;
  return account && account.isActive ? account : null;
}

const EMBED_ALLOWED_TIERS: readonly AccessTier[] = ['viewer_exec', 'analyst', 'developer'];
const REVIEW_ALLOWED_TIERS: readonly AccessTier[] = ['analyst', 'developer'];

/**
 * `key` is the portal-facing dashboard name (e.g. "ops") from the URL, not a
 * Superset id -- resolved against `config.supersetEmbed.dashboards`, which an
 * operator populates from config/superset/bootstrap_embed.py's output (see
 * README §6.13). Adding a dashboard is an .env edit, never a new route.
 */
async function embedDashboard(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (!EMBED_ALLOWED_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  if (!config.supersetEmbed) {
    sendJson(res, 503, { error: 'embedding_not_configured' });
    return;
  }
  const dashboardUuid = config.supersetEmbed.dashboards.get(key);
  if (!dashboardUuid) {
    sendJson(res, 404, { error: 'dashboard_not_found' });
    return;
  }
  if (!account.username) {
    // Should not happen: every account with a granted tier has a
    // psu_username by config/platform/014-steward-developer-tiers.sql's
    // app_user_password_tier_needs_username constraint.
    console.error('[auth] embed requested for account with no psu_username', account.userId);
    sendJson(res, 500, { error: 'internal_error' });
    return;
  }

  try {
    const guestToken = await mintDashboardGuestToken(
      config.supersetEmbed,
      dashboardUuid,
      account.username,
      account.displayName,
    );
    sendJson(res, 200, {
      guestToken,
      dashboardEmbedUuid: dashboardUuid,
      supersetOrigin: config.supersetEmbed.publicOrigin,
    });
  } catch (error) {
    console.error('[auth] guest token mint failed', error);
    sendJson(res, 502, { error: 'embed_failed' });
  }
}

/**
 * Directory components stripped, nothing else -- this is what
 * `identity.upload_event.original_filename` records, so a reviewer sees the
 * file's real name (Thai or otherwise) rather than an ASCII-mangled one.
 * Never used to build a path this process opens on disk or an object key
 * (see safeObjectFileName for that).
 */
function displayFilename(name: string): string {
  return name.split(/[/\\]/).pop() || 'upload';
}

const GENERIC_UPLOAD_NAMES = { csv: 'data.csv', pdf: 'document.pdf', docx: 'document.docx' } as const;

/**
 * The object key's own leaf name only needs to be safe and reasonably
 * distinctive for an operator browsing RustFS Console -- it is not what a
 * reviewer reads to know what the file is (that is `original_filename`,
 * kept faithful in the database), and it does not need to be unique
 * (services/auth/src/rustfs.ts already isolates every upload in its own
 * `<uploadId>` directory). Non-ASCII characters become `_`; a name that is
 * *entirely* non-ASCII (a Thai filename, most often) would otherwise turn
 * into a wall of underscores with no information left in it at all, so that
 * case falls back to a short generic name instead.
 */
function safeObjectFileName(originalName: string, fileKind: 'csv' | 'pdf' | 'docx'): string {
  const base = displayFilename(originalName);
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  const stem = cleaned.replace(/\.[^.]*$/, '');
  return /[A-Za-z0-9]/.test(stem) ? cleaned : GENERIC_UPLOAD_NAMES[fileKind];
}

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

interface ParsedUpload {
  filename: string;
  buffer: Buffer;
  note: string | null;
}

function parseSingleFileUpload(req: IncomingMessage): Promise<ParsedUpload | 'too_large' | null> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: UPLOAD_MAX_BYTES },
        // Busboy decodes Content-Disposition params (including filename) as
        // latin1 by default and leaves it there unless told otherwise --
        // every non-ASCII filename (Thai, most often, for this deployment)
        // would otherwise come out as mojibake. This is busboy's own
        // documented option for exactly that, not a manual re-decode.
        defParamCharset: 'utf8',
      });
    } catch (error) {
      reject(error as Error);
      return;
    }

    let result: ParsedUpload | null = null;
    let note: string | null = null;
    let tooLarge = false;
    let filePromise: Promise<void> | null = null;

    bb.on('field', (name, val) => {
      if (name === 'note' && typeof val === 'string') {
        note = val.trim().slice(0, 1000);
      }
    });

    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = [];
      filePromise = new Promise((resFile) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('limit', () => {
          tooLarge = true;
        });
        stream.on('close', () => {
          if (!tooLarge) {
            result = { filename: displayFilename(info.filename), buffer: Buffer.concat(chunks), note: null };
          }
          resFile();
        });
      });
    });
    bb.on('error', (error) => reject(error as Error));

    const onComplete = async () => {
      if (filePromise) {
        await filePromise;
      }
      if (result && note) {
        result.note = note;
      }
      resolve(tooLarge ? 'too_large' : result);
    };

    bb.on('close', () => {
      void onComplete();
    });

    req.pipe(bb);
  });
}

async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (account.accessTier !== 'steward') {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  if (!config.rustfs) {
    sendJson(res, 503, { error: 'uploads_not_configured' });
    return;
  }
  if (!account.orgUnit) {
    // Should not happen: app_user_viewer_is_scoped requires org_unit for a
    // steward-tier account.
    console.error('[auth] upload attempted by steward account with no org_unit', account.userId);
    sendJson(res, 500, { error: 'internal_error' });
    return;
  }

  let parsed: ParsedUpload | 'too_large' | null;
  try {
    parsed = await parseSingleFileUpload(req);
  } catch (error) {
    console.error('[auth] upload parse failed', error);
    sendJson(res, 400, { error: 'invalid_upload' });
    return;
  }
  if (parsed === 'too_large') {
    sendJson(res, 413, { error: 'file_too_large', maxBytes: UPLOAD_MAX_BYTES });
    return;
  }
  if (!parsed || parsed.buffer.byteLength === 0) {
    sendJson(res, 400, { error: 'no_file' });
    return;
  }
  const lowerFilename = parsed.filename.toLowerCase();
  const fileKind: 'csv' | 'pdf' | 'docx' | null = lowerFilename.endsWith('.csv')
    ? 'csv'
    : lowerFilename.endsWith('.pdf')
      ? 'pdf'
      : lowerFilename.endsWith('.docx')
        ? 'docx'
        : null;
  if (!fileKind) {
    sendJson(res, 400, { error: 'unsupported_file_type' });
    return;
  }

  try {
    const uploadId = crypto.randomUUID();
    const staged = await putStagedUpload(
      config.rustfs,
      account.orgUnit,
      uploadId,
      safeObjectFileName(parsed.filename, fileKind),
      parsed.buffer,
    );

    let extractedTextKey: string | null = null;
    if (fileKind === 'pdf' || fileKind === 'docx') {
      const text = await extractPlainText(fileKind, parsed.buffer);
      if (text !== null) {
        extractedTextKey = `${staged.objectKey}.extracted.txt`;
        await putObject(config.rustfs, extractedTextKey, text, 'text/plain; charset=utf-8');
      }
    }

    await store.recordUpload(
      uploadId,
      account.userId,
      account.orgUnit,
      staged.objectKey,
      parsed.filename,
      staged.sizeBytes,
      fileKind,
      extractedTextKey,
      parsed.note,
    );
    sendJson(res, 200, { ok: true, uploadId, objectKey: staged.objectKey, sizeBytes: staged.sizeBytes });
  } catch (error) {
    console.error('[auth] upload failed', error);
    sendJson(res, 502, { error: 'upload_failed' });
  }
}

async function handleListUploads(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (account.accessTier !== 'steward') {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }

  try {
    const uploads = await store.listUploadsForUser(account.userId);
    sendJson(res, 200, { uploads });
  } catch (error) {
    console.error('[auth] list uploads failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

function parseCsvPreview(content: string, maxRows = 20) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { columns: [], sampleRows: [], totalSampleRows: 0 };
  }

  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    fields.push(cur.trim());
    return fields;
  }

  const firstLine = lines[0];
  if (!firstLine) {
    return { columns: [], sampleRows: [], totalSampleRows: 0 };
  }
  const rawHeaders = parseLine(firstLine);
  const sampleDataLines = lines.slice(1, maxRows + 1);
  const sampleRows = sampleDataLines.map(parseLine);

  const columns = rawHeaders.map((rawHeader, idx) => {
    let name = rawHeader.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (!name || !/^[a-z]/.test(name)) {
      name = `col_${name || idx + 1}`;
    }

    let inferredType = 'VARCHAR';
    const values: string[] = sampleRows
      .map((r) => r[idx])
      .filter((v): v is string => typeof v === 'string' && v !== '');
    if (values.length > 0) {
      if (values.every((v) => /^-?\d+$/.test(v))) {
        inferredType = values.some((v) => {
          try {
            const n = BigInt(v);
            return n > 2147483647n || n < -2147483648n;
          } catch {
            return false;
          }
        })
          ? 'BIGINT'
          : 'INTEGER';
      } else if (values.every((v) => /^-?\d+(\.\d+)?$/.test(v))) {
        inferredType = 'DOUBLE';
      } else if (values.every((v) => /^(true|false|t|f|1|0)$/i.test(v))) {
        inferredType = 'BOOLEAN';
      } else if (values.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
        inferredType = 'DATE';
      } else if (values.every((v) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v))) {
        inferredType = 'TIMESTAMP';
      }
    }

    const isSensitive = /(id|citizen|passport|ssn|name|phone|tel|email|salary|wage|gpa|birth|address|gender)/i.test(name);
    const classification: 'public' | 'internal' | 'sensitive' = isSensitive ? 'sensitive' : 'public';

    return {
      name,
      originalName: rawHeader,
      type: inferredType,
      classification,
    };
  });

  return {
    columns,
    sampleRows,
    totalSampleRows: sampleRows.length,
  };
}

async function handleListReviews(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (!REVIEW_ALLOWED_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }

  try {
    const uploads = await store.listAllUploadsForReview();
    sendJson(res, 200, { uploads });
  } catch (error) {
    console.error('[auth] list reviews failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

async function handleGetReviewPreview(
  req: IncomingMessage,
  res: ServerResponse,
  uploadId: string,
): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (!REVIEW_ALLOWED_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  if (!config.rustfs) {
    sendJson(res, 503, { error: 'rustfs_not_configured' });
    return;
  }

  try {
    const upload = await store.getUploadForReview(uploadId);
    if (!upload) {
      sendJson(res, 404, { error: 'upload_not_found' });
      return;
    }

    if (upload.fileKind === 'csv') {
      if (!upload.objectKey) {
        sendJson(res, 400, { error: 'missing_object_key' });
        return;
      }
      const raw = await getObject(config.rustfs, upload.objectKey, 256 * 1024);
      const preview = parseCsvPreview(raw.toString('utf-8'));
      sendJson(res, 200, { upload, preview });
      return;
    }

    if (upload.fileKind === 'pdf' || upload.fileKind === 'docx') {
      let extractedText: string | null = null;
      if (upload.extractedTextKey) {
        try {
          const rawText = await getObject(config.rustfs, upload.extractedTextKey, 64 * 1024);
          extractedText = rawText.toString('utf-8');
        } catch (e) {
          console.warn('[auth] could not fetch extracted text:', e);
        }
      }
      sendJson(res, 200, {
        upload,
        preview: {
          fileKind: upload.fileKind,
          hasExtractedText: extractedText !== null,
          extractedText,
        },
      });
      return;
    }

    sendJson(res, 400, { error: 'unsupported_file_type' });
  } catch (error) {
    console.error('[auth] review preview failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

interface ApproveBody {
  tableSuffix?: string;
  columns?: ReviewColumn[];
}

async function handleApproveReview(
  req: IncomingMessage,
  res: ServerResponse,
  uploadId: string,
): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (!REVIEW_ALLOWED_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  const reviewerUsername = account.username;
  if (!reviewerUsername) {
    sendJson(res, 400, { error: 'reviewer_username_required' });
    return;
  }

  const upload = await store.getUploadForReview(uploadId);
  if (!upload) {
    sendJson(res, 404, { error: 'upload_not_found' });
    return;
  }
  if (upload.status !== 'pending_review') {
    sendJson(res, 409, { error: 'upload_already_decided', currentStatus: upload.status });
    return;
  }

  if (upload.fileKind === 'csv') {
    if (!config.trino) {
      sendJson(res, 503, { error: 'trino_not_configured' });
      return;
    }
    if (!config.rustfs) {
      sendJson(res, 503, { error: 'rustfs_not_configured' });
      return;
    }
    if (!upload.objectKey) {
      sendJson(res, 400, { error: 'missing_object_key' });
      return;
    }

    const body = await readJsonBody<ApproveBody>(req);
    const tableSuffix = (typeof body?.tableSuffix === 'string' ? body.tableSuffix.trim().toLowerCase() : '');
    const columns = Array.isArray(body?.columns) ? body!.columns : [];

    if (!/^[a-z][a-z0-9_]*$/.test(tableSuffix)) {
      sendJson(res, 400, { error: 'invalid_table_suffix', message: 'tableSuffix must match ^[a-z][a-z0-9_]*$' });
      return;
    }
    if (columns.length === 0) {
      sendJson(res, 400, { error: 'columns_required' });
      return;
    }

    try {
      const bridgeResult = await bridgeCsvToIceberg(config.trino, {
        uploadId,
        orgUnit: upload.orgUnit,
        tableSuffix,
        bucket: config.rustfs.bucket,
        objectKey: upload.objectKey,
        uploadedBy: upload.uploaderUsername || upload.userId,
        columns,
      });

      await store.recordReviewDecision(
        uploadId,
        'registered',
        reviewerUsername,
        bridgeResult.targetTable,
        bridgeResult.columnsIncluded,
        bridgeResult.columnsExcluded,
      );

      sendJson(res, 200, {
        ok: true,
        status: 'registered',
        targetTable: bridgeResult.targetTable,
        columnsIncluded: bridgeResult.columnsIncluded,
        columnsExcluded: bridgeResult.columnsExcluded,
      });
      return;
    } catch (err: any) {
      console.error('[auth] csv bridge to iceberg failed:', err);
      sendJson(res, 500, { error: 'bridge_failed', detail: err.message || String(err) });
      return;
    }
  }

  try {
    await store.recordReviewDecision(uploadId, 'registered', reviewerUsername, null, null, null);
    sendJson(res, 200, { ok: true, status: 'registered' });
  } catch (error) {
    console.error('[auth] document approval failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

async function handleRejectReview(
  req: IncomingMessage,
  res: ServerResponse,
  uploadId: string,
): Promise<void> {
  const cookies = readCookies(req.headers.cookie);
  const account = await requireAccount(cookies);
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return;
  }
  if (!REVIEW_ALLOWED_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  const reviewerUsername = account.username;
  if (!reviewerUsername) {
    sendJson(res, 400, { error: 'reviewer_username_required' });
    return;
  }

  const upload = await store.getUploadForReview(uploadId);
  if (!upload) {
    sendJson(res, 404, { error: 'upload_not_found' });
    return;
  }
  if (upload.status !== 'pending_review') {
    sendJson(res, 409, { error: 'upload_already_decided', currentStatus: upload.status });
    return;
  }

  interface RejectBody {
    reason?: unknown;
  }
  const body = await readJsonBody<RejectBody>(req);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : null;

  try {
    await store.recordReviewDecision(uploadId, 'rejected', reviewerUsername, null, null, null, reason);
    sendJson(res, 200, { ok: true, status: 'rejected', reason });
  } catch (error) {
    console.error('[auth] rejection failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

async function route(
  oidc: OidcProvider | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', config.publicOrigin);
  const cookies = readCookies(req.headers.cookie);

  if (url.pathname === '/auth/health') {
    sendJson(res, 200, { status: 'ok', psuPassport: oidc !== null });
    return;
  }

  if (url.pathname === '/auth/me') {
    const token = cookies.get(config.session.cookieName);
    const account = token ? await store.readSession(token) : null;
    if (!account || !account.isActive) {
      sendJson(res, 200, { authenticated: false });
      return;
    }
    sendJson(res, 200, { authenticated: true, user: publicProfile(account) });
    return;
  }

  if (url.pathname === '/auth/password/login' && req.method === 'POST') {
    await passwordLogin(req, res);
    return;
  }

  if (url.pathname.startsWith('/auth/embeds/') && req.method === 'GET') {
    const key = decodeURIComponent(url.pathname.slice('/auth/embeds/'.length));
    if (!key) {
      sendJson(res, 404, { error: 'dashboard_not_found' });
      return;
    }
    await embedDashboard(req, res, key);
    return;
  }

  if (url.pathname === '/auth/uploads') {
    if (req.method === 'POST') {
      await handleUpload(req, res);
      return;
    }
    if (req.method === 'GET') {
      await handleListUploads(req, res);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/auth/reviews' && req.method === 'GET') {
    await handleListReviews(req, res);
    return;
  }

  const reviewMatch = url.pathname.match(/^\/auth\/reviews\/([^/]+)\/(preview|approve|reject)$/);
  if (reviewMatch && reviewMatch[1] && reviewMatch[2]) {
    const uploadId = reviewMatch[1];
    const action = reviewMatch[2];
    if (action === 'preview' && req.method === 'GET') {
      await handleGetReviewPreview(req, res, uploadId);
      return;
    }
    if (action === 'approve' && req.method === 'POST') {
      await handleApproveReview(req, res, uploadId);
      return;
    }
    if (action === 'reject' && req.method === 'POST') {
      await handleRejectReview(req, res, uploadId);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/auth/login' && req.method === 'GET') {
    if (!oidc) {
      sendJson(res, 503, { error: 'psu_passport_not_configured' });
      return;
    }
    const next = safeNextPath(url.searchParams.get('next'));
    const started = await oidc.begin(next);
    setCookie(res, OIDC_HANDLE_COOKIE, started.handle, {
      maxAgeSeconds: 600,
      secure: config.session.secure,
    });
    sendRedirect(res, started.url.toString());
    return;
  }

  if (oidc && url.pathname === config.oidc?.callbackPath && req.method === 'GET') {
    await completeLogin(oidc, url, cookies.get(OIDC_HANDLE_COOKIE), res);
    return;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const token = cookies.get(config.session.cookieName);
    if (token) {
      const account = await store.readSession(token);
      await store.deleteSession(token);
      if (account) {
        await store.recordLogin(account.userId, 'succeeded', 'signed_out');
      }
    }
    clearCookie(res, config.session.cookieName, config.session.secure);
    const endSession = oidc?.endSessionUrl();
    sendJson(res, 200, { signedOut: true, endSessionUrl: endSession?.toString() ?? null });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function main(): Promise<void> {
  await store.ping();

  // PSU Passport is optional at the process level. A deployment with no
  // registered client still serves email-and-password sign-in; only the two
  // OIDC routes answer 503, checked in route() above.
  let oidc: OidcProvider | null = null;
  if (config.oidc) {
    oidc = await OidcProvider.create({ ...config, oidc: config.oidc });
    console.info(`[auth] PSU Passport discovery complete; redirect_uri is ${oidc.redirectUri}`);
  } else {
    console.warn(
      '[auth] OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET not set; ' +
        'PSU Passport sign-in is disabled, email-and-password sign-in still works',
    );
  }

  const server = createServer((req, res) => {
    void route(oidc, req, res).catch((error: unknown) => {
      // The detail stays in the log; the browser is told only that it failed.
      console.error('[auth] unhandled request failure', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      }
    });
  });

  server.listen(config.port, () => {
    console.info(`[auth] listening on ${config.port}`);
  });

  // Retention is applied by the service that owns the data, on a timer, rather
  // than by an operator remembering to run it.
  const purgeTimer = setInterval(() => {
    void store.purgeExpired().catch((error: unknown) => {
      console.error('[auth] retention purge failed', error);
    });
  }, 60 * 60 * 1000);
  purgeTimer.unref();

  const rateLimiterSweepTimer = setInterval(() => rateLimiter.sweep(), 10 * 60 * 1000);
  rateLimiterSweepTimer.unref();

  const shutdown = (signal: string): void => {
    console.info(`[auth] ${signal} received, shutting down`);
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[auth] failed to start', error);
  process.exit(1);
});
