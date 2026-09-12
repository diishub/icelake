/**
 * Settings are read once at start-up and validated there, so a missing or
 * malformed value stops the service instead of surfacing as a failed sign-in
 * later. Nothing in this module is ever logged: several of these values are
 * credentials.
 */

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const optional = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const number = (name: string, fallback: number): number => {
  const raw = optional(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
};

const boolean = (name: string, fallback: boolean): boolean => {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) {
    return fallback;
  }
  if (raw === 'true' || raw === 'false') {
    return raw === 'true';
  }
  throw new Error(`${name} must be true or false`);
};

const list = (name: string, fallback: string[]): string[] => {
  const raw = optional(name);
  if (!raw) {
    return fallback;
  }
  const items = raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
};

/**
 * Campus databases behind `/regist/v3/student/:campus`, tried in order when a
 * student's campus is not yet known: 01 Hat Yai, 02 Pattani, 03 Phuket,
 * 04 Surat Thani, 05 Trang.
 */
const DEFAULT_CAMPUS_CODES = ['01', '02', '03', '04', '05'];

export interface AppConfig {
  port: number;
  publicOrigin: string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scope: string;
    callbackPath: string;
    usernameClaim: string;
    nameClaim: string;
    emailClaim: string;
    campusClaim: string | undefined;
    postLogoutRedirect: string | undefined;
  };
  directory: {
    baseUrl: string;
    studentKey: string | undefined;
    staffKey: string | undefined;
    campusCodes: string[];
    timeoutMs: number;
  };
  session: {
    cookieName: string;
    ttlSeconds: number;
    secure: boolean;
  };
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}

export function readConfig(): AppConfig {
  const publicOrigin = required('AUTH_PUBLIC_ORIGIN').replace(/\/+$/, '');
  const callbackPath = optional('OIDC_CALLBACK_PATH') ?? '/auth/callback';

  if (!callbackPath.startsWith('/')) {
    throw new Error('OIDC_CALLBACK_PATH must start with /');
  }

  return {
    port: number('AUTH_PORT', 8087),
    publicOrigin,
    oidc: {
      issuer: required('OIDC_ISSUER'),
      clientId: required('OIDC_CLIENT_ID'),
      clientSecret: required('OIDC_CLIENT_SECRET'),
      scope: optional('OIDC_SCOPE') ?? 'openid profile email',
      callbackPath,
      // PSU Passport accounts arrive with the full address as the preferred
      // username; the gateway is keyed by the bare form, which resolveUsername
      // derives. The claim names themselves are deployment specific.
      usernameClaim: optional('OIDC_USERNAME_CLAIM') ?? 'preferred_username',
      nameClaim: optional('OIDC_NAME_CLAIM') ?? 'name',
      emailClaim: optional('OIDC_EMAIL_CLAIM') ?? 'email',
      campusClaim: optional('OIDC_CAMPUS_CLAIM'),
      postLogoutRedirect: optional('OIDC_POST_LOGOUT_REDIRECT_URI'),
    },
    directory: {
      baseUrl: (optional('API_PSU_GATEWAY') ?? 'https://api-gateway.psu.ac.th:8443').replace(/\/+$/, ''),
      studentKey: optional('API_STUDENT_KEY'),
      staffKey: optional('API_STAFF_KEY'),
      campusCodes: list('PSU_CAMPUS_CODES', DEFAULT_CAMPUS_CODES),
      timeoutMs: number('PSU_API_TIMEOUT_MS', 5000),
    },
    session: {
      cookieName: optional('AUTH_COOKIE_NAME') ?? 'psu_hub_session',
      ttlSeconds: number('AUTH_SESSION_TTL_SECONDS', 8 * 60 * 60),
      // Secure by default. Browsers accept Secure cookies on http://localhost,
      // so the loopback deployment needs no exception; a deployment reached by
      // plain HTTP on another host has a bigger problem than this flag.
      secure: boolean('AUTH_COOKIE_SECURE', true),
    },
    database: {
      host: optional('IDENTITY_DB_HOST') ?? 'postgres',
      port: number('IDENTITY_DB_PORT', 5432),
      database: optional('IDENTITY_DB_NAME') ?? 'platform',
      user: optional('IDENTITY_DB_USER') ?? 'identity_app',
      password: required('IDENTITY_DB_PASSWORD'),
    },
  };
}
