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

import { readConfig } from './config.js';
import { resolveDirectory } from './directory.js';
import { OidcProvider } from './oidc.js';
import { LoginRateLimiter, verifyPassword } from './password.js';
import { IdentityStore } from './store.js';
import {
  clearCookie, readCookies, readJsonBody, safeNextPath, sendJson, sendRedirect, setCookie,
} from './http.js';

import type { Account } from './store.js';

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
