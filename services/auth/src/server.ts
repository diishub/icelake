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
 *     are created by an administrator: from the host
 *     (scripts/create-password-account.sh) or by an 'admin' account on the
 *     portal's admin page (/auth/admin/*), never by self-registration.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import Busboy from 'busboy';

import { readConfig } from './config.js';
import { resolveDirectory } from './directory.js';
import { OidcProvider } from './oidc.js';
import { hashPassword, LoginRateLimiter, verifyPassword } from './password.js';
import { ADMIN_ASSIGNABLE_TIERS, AdminActionError, IdentityStore } from './store.js';
import { mintDashboardGuestToken } from './supersetEmbed.js';
import { putStagedUpload, putObject, getObject } from './rustfs.js';
import { BridgeInputError, bridgeCsvToIceberg, planCsvBridge } from './trino.js';
import type { BridgeParams, ReviewColumn } from './trino.js';
import {
  listCuratedTables, previewCuratedTable, publishCuratedTable, PublishError, TABLE_NAME,
} from './publish.js';
import { extractPlainText } from './textExtract.js';
import {
  clearCookie, readCookies, readJsonBody, safeNextPath, sendJson, sendRedirect, setCookie,
} from './http.js';

import { ReleaseConflictError } from './store.js';
import type {
  Account, AccessTier, ReleaseAccessLevel, ReleaseCadence, ReleaseRecord, ReleaseRequestInput,
} from './store.js';

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
  // Drives role-specific portal rendering (portal/src/pages/index.tsx). Not a secret -- it
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

  const check = await checkPasswordCredentials(email, password);
  if (sendCredentialRefusal(res, check)) {
    return;
  }
  const account = await store.recordPasswordLogin(check.account.userId);
  await establishSession(res, account.userId);
  await store.recordLogin(account.userId, 'succeeded', 'signed_in');
  sendJson(res, 200, { ok: true, next, user: publicProfile(account) });
}

type CredentialCheck =
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid' }
  | { kind: 'disabled' }
  | { kind: 'ok'; account: Account };

/**
 * What both password sign-in paths -- the portal's and Superset's -- check,
 * in the same order and against the same rate limiter, so a guess spent on
 * one counts against the other. Every refusal is recorded here.
 */
async function checkPasswordCredentials(email: string, password: string): Promise<CredentialCheck> {
  const limiterKey = email.toLowerCase();
  const limit = rateLimiter.check(limiterKey);
  if (!limit.allowed) {
    await store.recordLogin(null, 'denied', 'rate_limited');
    return { kind: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  }

  const found = await store.findByEmailForPasswordLogin(email);
  const passwordMatches = await verifyPassword(password, found?.passwordHash);

  if (!found || !passwordMatches) {
    rateLimiter.recordFailure(limiterKey);
    await store.recordLogin(found?.account.userId ?? null, 'denied', 'invalid_credentials');
    return { kind: 'invalid' };
  }

  if (!found.account.isActive) {
    rateLimiter.recordFailure(limiterKey);
    await store.recordLogin(found.account.userId, 'denied', 'account_disabled');
    return { kind: 'disabled' };
  }

  rateLimiter.clear(limiterKey);
  return { kind: 'ok', account: found.account };
}

/** Sends the response for a refused check; false (nothing sent) when it passed. */
function sendCredentialRefusal(
  res: ServerResponse,
  check: CredentialCheck,
): check is Exclude<CredentialCheck, { kind: 'ok' }> {
  switch (check.kind) {
    case 'rate_limited':
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      sendJson(res, 429, { error: 'too_many_attempts', retryAfterSeconds: check.retryAfterSeconds });
      return true;
    case 'invalid':
      sendJson(res, 401, { error: 'invalid_credentials' });
      return true;
    case 'disabled':
      sendJson(res, 403, { error: 'account_disabled' });
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Superset sign-in with a portal password
// ---------------------------------------------------------------------------
//
// Until PSU Passport is switched on, Superset has its own user table. Rather
// than give every analyst a second password, Superset's security manager
// (config/superset/psu_security_manager.py) sends the email and password it
// was given here and gets back the name to create the Superset account under
// -- the psu_username Trino impersonates -- and the tier, which it maps to a
// Superset role on every sign-in. The hash never leaves this service.
//
// This answers on its own port (SUPERSET_LOGIN_BRIDGE_PORT), which compose
// does not publish and nginx does not proxy, and only to a caller presenting
// SUPERSET_LOGIN_BRIDGE_SECRET. Viewers have no Superset access: their
// reports are embedded in the portal.

const SUPERSET_LOGIN_TIERS: readonly AccessTier[] = ['analyst', 'admin'];
const SUPERSET_LOGIN_PATH = '/internal/superset/verify-password';

/** Constant-time comparison of the presented bearer token with the configured secret. */
function bridgeCallerAuthorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!presented) {
    return false;
  }
  // Hashing first gives both sides the same length, which timingSafeEqual needs.
  const expected = createHash('sha256').update(secret).digest();
  const actual = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expected, actual);
}

async function supersetVerifyPassword(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
  if (!bridgeCallerAuthorized(req, secret)) {
    sendJson(res, 401, { error: 'not_authorized' });
    return;
  }
  const body = await readJsonBody<PasswordLoginBody>(req);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }

  const check = await checkPasswordCredentials(email, password);
  if (sendCredentialRefusal(res, check)) {
    return;
  }
  const { account } = check;
  if (!SUPERSET_LOGIN_TIERS.includes(account.accessTier) || !account.username) {
    await store.recordLogin(account.userId, 'denied', 'tier_not_permitted');
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  await store.recordPasswordLogin(account.userId);
  await store.recordLogin(account.userId, 'succeeded', 'superset_signed_in');
  sendJson(res, 200, {
    username: account.username,
    displayName: account.displayName,
    accessTier: account.accessTier,
  });
}

/** Reads the session cookie and returns the live account, or null if signed out. */
async function requireAccount(cookies: Map<string, string>): Promise<Account | null> {
  const token = cookies.get(config.session.cookieName);
  const account = token ? await store.readSession(token) : null;
  return account && account.isActive ? account : null;
}

// Three tiers (config/platform/024-three-tiers.sql): viewer, analyst and
// admin, the one full-access tier.
const EMBED_ALLOWED_TIERS: readonly AccessTier[] = ['viewer', 'analyst', 'admin'];
const REVIEW_ALLOWED_TIERS: readonly AccessTier[] = ['analyst', 'admin'];

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
// Who submits files: viewers (the old steward's page), and admins.
const UPLOAD_TIERS: readonly AccessTier[] = ['viewer', 'admin'];

interface ParsedUpload {
  filename: string;
  buffer: Buffer;
  note: string | null;
  /** As sent; handleUpload validates it. */
  orgUnit: string | null;
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
    let orgUnit: string | null = null;
    let tooLarge = false;
    let filePromise: Promise<void> | null = null;

    bb.on('field', (name, val) => {
      if (name === 'note' && typeof val === 'string') {
        note = val.trim().slice(0, 1000);
      } else if (name === 'orgUnit' && typeof val === 'string') {
        orgUnit = val.trim().toLowerCase();
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
            result = { filename: displayFilename(info.filename), buffer: Buffer.concat(chunks), note: null, orgUnit: null };
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
      if (result) {
        result.note = note;
        result.orgUnit = orgUnit;
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
  if (!UPLOAD_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  if (!config.rustfs) {
    sendJson(res, 503, { error: 'uploads_not_configured' });
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
  // The submitter names the unit the file belongs to; accounts carry none
  // (024-three-tiers.sql). It becomes part of the object key and, later, of a
  // Trino table name, so it is held to the same shape as everywhere else.
  const orgUnit = parsed.orgUnit;
  if (!orgUnit || !ORG_UNIT.test(orgUnit)) {
    sendJson(res, 400, { error: 'invalid_org_unit' });
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
      orgUnit,
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
      orgUnit,
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
  if (!UPLOAD_TIERS.includes(account.accessTier)) {
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

    if (columns.length === 0) {
      sendJson(res, 400, { error: 'columns_required' });
      return;
    }
    try {
      planCsvBridge({ tableSuffix, columns });
    } catch (error) {
      if (error instanceof BridgeInputError) {
        sendJson(res, 400, { error: error.code, message: error.message });
        return;
      }
      throw error;
    }

    // The load can outlast nginx's wait for /auth/, so it runs after the
    // response; the portal polls the upload until it leaves 'loading'.
    if (!(await store.claimForLoading(uploadId, reviewerUsername))) {
      sendJson(res, 409, { error: 'upload_already_decided' });
      return;
    }
    sendJson(res, 202, { ok: true, status: 'loading' });
    void runCsvLoad({
      uploadId,
      orgUnit: upload.orgUnit,
      tableSuffix,
      bucket: config.rustfs.bucket,
      objectKey: upload.objectKey,
      uploadedBy: upload.uploaderUsername || upload.userId,
      columns,
    }).catch((error: unknown) => {
      console.error(`[auth] upload ${uploadId} could not record its load outcome`, error);
    });
    return;
  }

  try {
    await store.recordReviewDecision(uploadId, 'registered', reviewerUsername, null, null, null);
    sendJson(res, 200, { ok: true, status: 'registered' });
  } catch (error) {
    console.error('[auth] document approval failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

/** The Iceberg load, after the approve response has gone. Every outcome lands on the upload row. */
async function runCsvLoad(params: BridgeParams): Promise<void> {
  try {
    const result = await bridgeCsvToIceberg(config.trino!, params);
    await store.markLoaded(params.uploadId, result.targetTable, result.columnsIncluded, result.columnsExcluded);
    console.info(`[auth] upload ${params.uploadId} loaded into ${result.targetTable}`);
  } catch (error) {
    console.error(`[auth] upload ${params.uploadId} load into iceberg failed`, error);
    await store.markLoadFailed(params.uploadId, 'load_failed');
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

// ---------------------------------------------------------------------------
// Dataset releases: curated -> published
// ---------------------------------------------------------------------------
//
// An analyst or admin publishes directly: the release is recorded and
// approved by the same person in one call (config/platform/024-three-tiers.sql
// dropped the rule that nobody decides their own request). A release left in
// 'requested' from before that can still be approved or rejected by an
// analyst or admin. The copy itself runs
// as the Trino publisher identity -- the one non-admin identity OPA lets write
// published -- after the response has gone back, because a large table can
// take longer to copy than nginx waits for an answer.

const RELEASE_REQUEST_TIERS: readonly AccessTier[] = ['analyst', 'admin'];
const RELEASE_DOMAINS = ['student', 'personnel', 'research', 'academic_services', 'indicator'];
const RELEASE_ACCESS_LEVELS: readonly ReleaseAccessLevel[] = ['university', 'restricted'];
const RELEASE_CADENCES: readonly ReleaseCadence[] = ['manual', 'daily', 'weekly', 'monthly'];
const ORG_UNIT = /^[a-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who may see a release: publishers see all; nobody else sees any. */
function releaseScopeFor(account: Account): { orgUnit: string | null } | null {
  return RELEASE_REQUEST_TIERS.includes(account.accessTier) ? { orgUnit: null } : null;
}

function canDecide(account: Account): boolean {
  return RELEASE_REQUEST_TIERS.includes(account.accessTier);
}

/** The release plus what this viewer may do with it, so the portal never has to re-derive the rule. */
function releaseView(account: Account, release: ReleaseRecord) {
  return { ...release, canDecide: release.status === 'requested' && canDecide(account) };
}

function optionalText(value: unknown, max: number): string | null | 'invalid' {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return 'invalid';
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return 'invalid';
  }
  return trimmed.length > 0 ? trimmed : null;
}

function parseReleaseRequest(body: Record<string, unknown> | null): ReleaseRequestInput | string {
  if (!body) {
    return 'invalid_request';
  }
  const tableName = typeof body.tableName === 'string' ? body.tableName.trim() : '';
  if (!TABLE_NAME.test(tableName)) {
    return 'invalid_table_name';
  }
  const titleTh = optionalText(body.titleTh, 200);
  if (titleTh === null || titleTh === 'invalid') {
    return 'title_required';
  }
  const titleEn = optionalText(body.titleEn, 200);
  const descriptionTh = optionalText(body.descriptionTh, 2000);
  const descriptionEn = optionalText(body.descriptionEn, 2000);
  const changelog = optionalText(body.changelog, 2000);
  if ([titleEn, descriptionTh, descriptionEn, changelog].includes('invalid')) {
    return 'invalid_text_field';
  }
  const domain = optionalText(body.domain, 64);
  if (domain === 'invalid' || (domain !== null && !RELEASE_DOMAINS.includes(domain))) {
    return 'invalid_domain';
  }
  const ownerOrgUnit = typeof body.ownerOrgUnit === 'string' ? body.ownerOrgUnit.trim().toLowerCase() : '';
  if (!ORG_UNIT.test(ownerOrgUnit)) {
    return 'invalid_owner_org_unit';
  }
  const accessLevel = body.accessLevel ?? 'university';
  if (!RELEASE_ACCESS_LEVELS.includes(accessLevel as ReleaseAccessLevel)) {
    return 'invalid_access_level';
  }
  const refreshCadence = body.refreshCadence ?? 'manual';
  if (!RELEASE_CADENCES.includes(refreshCadence as ReleaseCadence)) {
    return 'invalid_refresh_cadence';
  }
  const rawTags = body.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > 10) {
    return 'invalid_tags';
  }
  const tags: string[] = [];
  for (const tag of rawTags) {
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.trim().length > 40) {
      return 'invalid_tags';
    }
    if (!tags.includes(tag.trim())) {
      tags.push(tag.trim());
    }
  }
  return {
    tableName,
    titleTh,
    titleEn: titleEn as string | null,
    descriptionTh: descriptionTh as string | null,
    descriptionEn: descriptionEn as string | null,
    domain,
    tags,
    ownerOrgUnit,
    accessLevel: accessLevel as ReleaseAccessLevel,
    refreshCadence: refreshCadence as ReleaseCadence,
    changelog: changelog as string | null,
  };
}

/** Signed-in account with some release scope, or null after the error has been sent. */
async function requireReleaseAccount(req: IncomingMessage, res: ServerResponse): Promise<Account | null> {
  const account = await requireAccount(readCookies(req.headers.cookie));
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return null;
  }
  if (!releaseScopeFor(account)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return null;
  }
  if (!config.publisher) {
    sendJson(res, 503, { error: 'publishing_not_configured' });
    return null;
  }
  return account;
}

async function handleListReleases(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await requireReleaseAccount(req, res);
  if (!account) {
    return;
  }
  const scope = releaseScopeFor(account)!;
  const releases = await store.releases.list(scope.orgUnit);
  sendJson(res, 200, {
    releases: releases.map((release) => releaseView(account, release)),
    canRequest: RELEASE_REQUEST_TIERS.includes(account.accessTier),
  });
}

async function handleListReleaseSources(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await requireReleaseAccount(req, res);
  if (!account) {
    return;
  }
  if (!RELEASE_REQUEST_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  try {
    sendJson(res, 200, { tables: await listCuratedTables(config.publisher!) });
  } catch (error) {
    console.error('[auth] listing curated tables failed', error);
    sendJson(res, 502, { error: 'trino_unavailable' });
  }
}

async function handleCreateRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await requireReleaseAccount(req, res);
  if (!account) {
    return;
  }
  if (!RELEASE_REQUEST_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return;
  }
  const parsed = parseReleaseRequest(await readJsonBody<Record<string, unknown>>(req));
  if (typeof parsed === 'string') {
    sendJson(res, 400, { error: parsed });
    return;
  }

  // Checked against Trino rather than trusted from the form: a release for a
  // table that is not a curated base table could never be approved anyway.
  let tables: string[];
  try {
    tables = await listCuratedTables(config.publisher!);
  } catch (error) {
    console.error('[auth] listing curated tables failed', error);
    sendJson(res, 502, { error: 'trino_unavailable' });
    return;
  }
  if (!tables.includes(parsed.tableName)) {
    sendJson(res, 404, { error: 'source_table_not_found' });
    return;
  }

  let release: ReleaseRecord;
  try {
    release = await store.releases.create(parsed, account.userId);
  } catch (error) {
    if (error instanceof ReleaseConflictError) {
      sendJson(res, 409, { error: 'release_already_open' });
      return;
    }
    throw error;
  }
  // Published by the person who asked, straight away.
  const claimed = await store.releases.claimForApproval(release.releaseId, account.userId);
  if (!claimed) {
    sendJson(res, 409, { error: 'release_already_decided' });
    return;
  }
  sendJson(res, 202, { release: releaseView(account, claimed) });
  void runRelease(claimed).catch((error: unknown) => {
    console.error(`[auth] release ${claimed.releaseId} could not record its outcome`, error);
  });
}

/** Reads a release the account is allowed to see; sends 404 for one it is not, so ids cannot be probed. */
async function visibleRelease(account: Account, releaseId: string, res: ServerResponse): Promise<ReleaseRecord | null> {
  const release = UUID.test(releaseId) ? await store.releases.get(releaseId) : null;
  const scope = releaseScopeFor(account);
  if (!release || !scope || (scope.orgUnit !== null && scope.orgUnit !== release.ownerOrgUnit)) {
    sendJson(res, 404, { error: 'release_not_found' });
    return null;
  }
  return release;
}

async function handleReleasePreview(req: IncomingMessage, res: ServerResponse, releaseId: string): Promise<void> {
  const account = await requireReleaseAccount(req, res);
  if (!account) {
    return;
  }
  const release = await visibleRelease(account, releaseId, res);
  if (!release) {
    return;
  }
  try {
    const preview = await previewCuratedTable(config.publisher!, release.tableName);
    sendJson(res, 200, { release: releaseView(account, release), preview });
  } catch (error) {
    console.error('[auth] release preview failed', error);
    sendJson(res, 502, { error: 'trino_unavailable' });
  }
}

/** The copy, after the approval response has gone. Every outcome lands on the release row. */
async function runRelease(release: ReleaseRecord): Promise<void> {
  try {
    const outcome = await publishCuratedTable(config.publisher!, release.tableName);
    await store.releases.markPublished(
      release.releaseId,
      outcome.sourceSnapshotId,
      outcome.publishedSnapshotId,
      outcome.rowCount,
    );
    console.info(`[auth] release ${release.releaseId} published ${release.tableName} v${release.version}`);
  } catch (error) {
    console.error(`[auth] release ${release.releaseId} failed`, error);
    const code = error instanceof PublishError ? error.code : 'copy_failed';
    const snapshot = error instanceof PublishError ? error.sourceSnapshotId : null;
    await store.releases.markFailed(release.releaseId, code, snapshot);
  }
}

async function handleApproveRelease(req: IncomingMessage, res: ServerResponse, releaseId: string): Promise<void> {
  const account = await requireReleaseAccount(req, res);
  if (!account) {
    return;
  }
  const release = await visibleRelease(account, releaseId, res);
  if (!release) {
    return;
  }
  if (!canDecide(account)) {
    sendJson(res, 403, { error: 'not_data_owner' });
    return;
  }
  const claimed = await store.releases.claimForApproval(release.releaseId, account.userId);
  if (!claimed) {
    sendJson(res, 409, { error: 'release_already_decided' });
    return;
  }
  sendJson(res, 202, { release: releaseView(account, claimed) });
  void runRelease(claimed).catch((error: unknown) => {
    console.error(`[auth] release ${claimed.releaseId} could not record its outcome`, error);
  });
}

async function handleRejectRelease(req: IncomingMessage, res: ServerResponse, releaseId: string): Promise<void> {
  const account = await requireReleaseAccount(req, res);
  if (!account) {
    return;
  }
  const release = await visibleRelease(account, releaseId, res);
  if (!release) {
    return;
  }
  if (!canDecide(account)) {
    sendJson(res, 403, { error: 'not_data_owner' });
    return;
  }
  const body = await readJsonBody<{ reason?: unknown }>(req);
  const reason = optionalText(body?.reason, 1000);
  if (reason === null || reason === 'invalid') {
    sendJson(res, 400, { error: 'reason_required' });
    return;
  }
  if (!(await store.releases.reject(release.releaseId, account.userId, reason))) {
    sendJson(res, 409, { error: 'release_already_decided' });
    return;
  }
  const updated = await store.releases.get(release.releaseId);
  sendJson(res, 200, { release: updated ? releaseView(account, updated) : null });
}

/**
 * The published releases the portal catalogue lists. Public, like
 * portal/data/catalog.json: titles and owners only, never who asked or
 * approved, and never a snapshot id.
 */
async function handleCatalogReleases(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { releases: await store.releases.listPublished() });
}

// ---------------------------------------------------------------------------
// Account administration: admins create accounts and grant tiers
// ---------------------------------------------------------------------------
//
// The portal's admin page drives these. The tier check here is the first of
// two: every write also goes through a SECURITY DEFINER function in
// config/platform/022-admin-tier.sql that re-checks the actor and refuses
// self-changes and tiers outside the assignable list on its own. A tier change
// reaches Trino through the trino-groups-sync service, not from here.

const USER_ADMIN_TIERS: readonly AccessTier[] = ['admin'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRINO_USERNAME = /^[a-z0-9._-]{1,64}$/;
const PASSWORD_MIN_LENGTH = 12;
// bcrypt reads at most 72 bytes; anything past that would be silently ignored.
const PASSWORD_MAX_BYTES = 72;
// The Superset<->Trino connection user. A portal account with this name would
// be impersonated as the connection itself.
const RESERVED_USERNAMES = new Set(['superset']);

async function requireUserAdmin(req: IncomingMessage, res: ServerResponse): Promise<Account | null> {
  const account = await requireAccount(readCookies(req.headers.cookie));
  if (!account) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return null;
  }
  if (!USER_ADMIN_TIERS.includes(account.accessTier)) {
    sendJson(res, 403, { error: 'tier_not_permitted' });
    return null;
  }
  return account;
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return 'password_too_short';
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return 'password_too_long';
  }
  return null;
}

/**
 * The tier, and no org unit: no tier is scoped to one any more
 * (config/platform/024-three-tiers.sql), so whatever was sent is ignored and
 * the account's org unit is cleared.
 */
function parseGrant(body: Record<string, unknown>): { accessTier: AccessTier; orgUnit: null } | string {
  const accessTier = body.accessTier;
  if (typeof accessTier !== 'string' || !ADMIN_ASSIGNABLE_TIERS.includes(accessTier as AccessTier)) {
    return 'tier_not_assignable';
  }
  return { accessTier: accessTier as AccessTier, orgUnit: null };
}

/** Sends the error for a refusal the database raised, or rethrows anything else. */
function sendAdminError(res: ServerResponse, error: unknown): void {
  if (!(error instanceof AdminActionError)) {
    throw error;
  }
  const status = error.code === 'account_not_found' ? 404
    : ['email_taken', 'username_taken'].includes(error.code) ? 409
    : ['not_admin', 'self_change_forbidden', 'tier_not_assignable'].includes(error.code) ? 403
    : 400;
  sendJson(res, status, { error: error.code });
}

async function handleListAccounts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await requireUserAdmin(req, res);
  if (!account) {
    return;
  }
  sendJson(res, 200, {
    accounts: await store.listManagedAccounts(),
    assignableTiers: ADMIN_ASSIGNABLE_TIERS,
    self: account.userId,
  });
}

async function handleCreateAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await requireUserAdmin(req, res);
  if (!account) {
    return;
  }
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL.test(email) || email.length > 254) {
    sendJson(res, 400, { error: 'invalid_email' });
    return;
  }
  const displayName = optionalText(body.displayName, 200);
  if (displayName === null || displayName === 'invalid') {
    sendJson(res, 400, { error: 'display_name_required' });
    return;
  }
  // Same derivation as scripts/create-password-account.sh when none is given.
  const requested = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const username = requested
    || (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (!TRINO_USERNAME.test(username) || RESERVED_USERNAMES.has(username)) {
    sendJson(res, 400, { error: 'invalid_username' });
    return;
  }
  const passwordError = passwordProblem(body.password);
  if (passwordError) {
    sendJson(res, 400, { error: passwordError });
    return;
  }
  const grant = parseGrant(body);
  if (typeof grant === 'string') {
    sendJson(res, 400, { error: grant });
    return;
  }

  const passwordHash = await hashPassword(body.password as string, config.passwordLogin.bcryptCost);
  try {
    const userId = await store.adminCreatePasswordAccount(
      account.userId,
      { email, displayName, username, ...grant },
      passwordHash,
    );
    console.info(`[auth] admin ${account.userId} created account ${userId} at tier ${grant.accessTier}`);
    sendJson(res, 201, { userId, username });
  } catch (error) {
    sendAdminError(res, error);
  }
}

async function handleUpdateAccount(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const account = await requireUserAdmin(req, res);
  if (!account) {
    return;
  }
  if (!UUID.test(userId)) {
    sendJson(res, 404, { error: 'account_not_found' });
    return;
  }
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body || typeof body.isActive !== 'boolean') {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }
  const grant = parseGrant(body);
  if (typeof grant === 'string') {
    sendJson(res, 400, { error: grant });
    return;
  }
  try {
    await store.adminUpdateAccount(account.userId, userId, grant.accessTier, grant.orgUnit, body.isActive);
    console.info(`[auth] admin ${account.userId} updated account ${userId}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendAdminError(res, error);
  }
}

async function handleResetPassword(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const account = await requireUserAdmin(req, res);
  if (!account) {
    return;
  }
  if (!UUID.test(userId)) {
    sendJson(res, 404, { error: 'account_not_found' });
    return;
  }
  const body = await readJsonBody<{ password?: unknown }>(req);
  const passwordError = passwordProblem(body?.password);
  if (passwordError) {
    sendJson(res, 400, { error: passwordError });
    return;
  }
  const passwordHash = await hashPassword(body!.password as string, config.passwordLogin.bcryptCost);
  try {
    await store.adminResetPassword(account.userId, userId, passwordHash);
    console.info(`[auth] admin ${account.userId} reset the password of account ${userId}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendAdminError(res, error);
  }
}

async function handleListAdminEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await requireUserAdmin(req, res);
  if (!account) {
    return;
  }
  sendJson(res, 200, { events: await store.listAdminEvents() });
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

  if (url.pathname === '/auth/catalog/releases' && req.method === 'GET') {
    await handleCatalogReleases(res);
    return;
  }

  if (url.pathname === '/auth/releases') {
    if (req.method === 'GET') {
      await handleListReleases(req, res);
      return;
    }
    if (req.method === 'POST') {
      await handleCreateRelease(req, res);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/auth/releases/sources' && req.method === 'GET') {
    await handleListReleaseSources(req, res);
    return;
  }

  const releaseMatch = url.pathname.match(/^\/auth\/releases\/([^/]+)\/(preview|approve|reject)$/);
  if (releaseMatch && releaseMatch[1] && releaseMatch[2]) {
    const releaseId = releaseMatch[1];
    const action = releaseMatch[2];
    if (action === 'preview' && req.method === 'GET') {
      await handleReleasePreview(req, res, releaseId);
      return;
    }
    if (action === 'approve' && req.method === 'POST') {
      await handleApproveRelease(req, res, releaseId);
      return;
    }
    if (action === 'reject' && req.method === 'POST') {
      await handleRejectRelease(req, res, releaseId);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/auth/admin/users') {
    if (req.method === 'GET') {
      await handleListAccounts(req, res);
      return;
    }
    if (req.method === 'POST') {
      await handleCreateAccount(req, res);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/auth/admin/events' && req.method === 'GET') {
    await handleListAdminEvents(req, res);
    return;
  }

  const adminUserMatch = url.pathname.match(/^\/auth\/admin\/users\/([^/]+)(\/password)?$/);
  if (adminUserMatch && adminUserMatch[1]) {
    const userId = adminUserMatch[1];
    if (adminUserMatch[2] && req.method === 'POST') {
      await handleResetPassword(req, res, userId);
      return;
    }
    if (!adminUserMatch[2] && req.method === 'PUT') {
      await handleUpdateAccount(req, res, userId);
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

  // Not fatal: sign-in must keep working on a database that has not had
  // 021-dataset-release.sql applied yet.
  try {
    const interrupted = await store.releases.failInterrupted();
    if (interrupted > 0) {
      console.warn(`[auth] ${interrupted} release(s) were interrupted by a restart and marked failed`);
    }
  } catch (error) {
    console.error('[auth] could not check for interrupted releases', error);
  }

  // Same for upload loads; not fatal before 026-upload-async-load.sql.
  try {
    const interrupted = await store.failInterruptedLoads();
    if (interrupted > 0) {
      console.warn(`[auth] ${interrupted} upload load(s) were interrupted by a restart and returned to review`);
    }
  } catch (error) {
    console.error('[auth] could not check for interrupted upload loads', error);
  }

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

  let bridge: ReturnType<typeof createServer> | null = null;
  if (config.supersetLoginBridge) {
    const { port, secret } = config.supersetLoginBridge;
    bridge = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://bridge').pathname;
      if (path !== SUPERSET_LOGIN_PATH || req.method !== 'POST') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      void supersetVerifyPassword(req, res, secret).catch((error: unknown) => {
        console.error('[auth] superset sign-in check failed', error);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal_error' });
        }
      });
    });
    bridge.listen(port, () => {
      console.info(`[auth] Superset login bridge listening on ${port}`);
    });
  }

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
    bridge?.close();
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
