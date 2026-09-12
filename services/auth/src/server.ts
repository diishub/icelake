/**
 * Sign-in for the PSU Data Hub portal.
 *
 * The portal itself is static files behind nginx, which cannot hold a client
 * secret or exchange an authorization code, so this service exists to do those
 * two things and nothing else. nginx proxies /auth/* here; everything else it
 * serves from disk.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readConfig } from './config.js';
import { resolveDirectory } from './directory.js';
import { OidcProvider } from './oidc.js';
import { IdentityStore } from './store.js';
import { clearCookie, readCookies, safeNextPath, sendJson, sendRedirect, setCookie } from './http.js';

import type { Account } from './store.js';

const OIDC_HANDLE_COOKIE = 'psu_hub_login';

const config = readConfig();
const store = new IdentityStore(config);

/** What the portal is told about the signed-in person, and no more. */
const publicProfile = (account: Account) => ({
  username: account.username,
  displayName: account.displayName,
  userType: account.userType,
  campusNameTh: account.campusNameTh,
  facultyNameTh: account.facultyNameTh,
  departmentNameTh: account.departmentNameTh,
});

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

  const token = await store.createSession(resolved.userId, config.session.ttlSeconds);
  setCookie(res, config.session.cookieName, token, {
    maxAgeSeconds: config.session.ttlSeconds,
    secure: config.session.secure,
  });
  await store.recordLogin(resolved.userId, 'succeeded', 'signed_in');
  sendRedirect(res, pending.next);
}

async function route(
  oidc: OidcProvider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', config.publicOrigin);
  const cookies = readCookies(req.headers.cookie);

  if (url.pathname === '/auth/health') {
    sendJson(res, 200, { status: 'ok' });
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

  if (url.pathname === '/auth/login' && req.method === 'GET') {
    const next = safeNextPath(url.searchParams.get('next'));
    const started = await oidc.begin(next);
    setCookie(res, OIDC_HANDLE_COOKIE, started.handle, {
      maxAgeSeconds: 600,
      secure: config.session.secure,
    });
    sendRedirect(res, started.url.toString());
    return;
  }

  if (url.pathname === config.oidc.callbackPath && req.method === 'GET') {
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
    const endSession = oidc.endSessionUrl();
    sendJson(res, 200, { signedOut: true, endSessionUrl: endSession?.toString() ?? null });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function main(): Promise<void> {
  await store.ping();
  const oidc = await OidcProvider.create(config);
  console.info(`[auth] discovery complete; redirect_uri is ${oidc.redirectUri}`);

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
