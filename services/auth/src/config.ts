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
  /**
   * Undefined when PSU Passport has no registered client on this deployment.
   * Email-and-password sign-in must keep working in that state, so nothing
   * downstream may assume this is always present.
   */
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
  } | undefined;
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
  /** Email-and-password sign-in. Accounts are provisioned by an administrator; see scripts/create-password-account.sh. */
  passwordLogin: {
    bcryptCost: number;
    maxAttemptsPerWindow: number;
    windowSeconds: number;
  };
  /**
   * Undefined when embedding isn't set up on this deployment (mirrors how
   * `oidc` above is optional) -- see config/superset/bootstrap_embed.py,
   * which creates the service account and enables embedding for the ops
   * dashboard.
   */
  supersetEmbed: {
    /** Where this service (server-to-server, inside the compose network) reaches Superset's REST API. */
    internalOrigin: string;
    /** Where the browser reaches Superset -- handed back to the portal for the embed iframe's src/CSP. */
    publicOrigin: string;
    serviceUsername: string;
    servicePassword: string;
    /**
     * Portal-facing dashboard key -> Superset embed UUID, e.g. {"ops": "<uuid>"}.
     * Populated from SUPERSET_EMBED_DASHBOARDS, itself copied from what
     * config/superset/bootstrap_embed.py prints. Adding a dashboard is an
     * .env edit, never a code change -- see README §6.13.
     */
    dashboards: Map<string, string>;
  } | undefined;
  /** Undefined when steward uploads aren't set up (no RustFS credentials). */
  rustfs: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  } | undefined;
  /** Undefined when Trino ingestion credentials are not configured. */
  trino: {
    endpoint: string;
    username: string;
    password: string;
  } | undefined;
}

export function readConfig(): AppConfig {
  const publicOrigin = required('AUTH_PUBLIC_ORIGIN').replace(/\/+$/, '');
  const callbackPath = optional('OIDC_CALLBACK_PATH') ?? '/auth/callback';

  if (!callbackPath.startsWith('/')) {
    throw new Error('OIDC_CALLBACK_PATH must start with /');
  }

  // The three values PSU Passport cannot work without. Read with optional()
  // rather than required(): a deployment with no registered client must still
  // start, because email-and-password sign-in has nothing to do with this
  // provider and must not be held hostage by its absence.
  const issuer = optional('OIDC_ISSUER');
  const clientId = optional('OIDC_CLIENT_ID');
  const clientSecret = optional('OIDC_CLIENT_SECRET');
  const oidcConfigured = issuer !== undefined && clientId !== undefined && clientSecret !== undefined;

  return {
    port: number('AUTH_PORT', 8087),
    publicOrigin,
    oidc: oidcConfigured ? {
      issuer,
      clientId,
      clientSecret,
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
    } : undefined,
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
    passwordLogin: {
      bcryptCost: number('PASSWORD_LOGIN_BCRYPT_COST', 12),
      maxAttemptsPerWindow: number('PASSWORD_LOGIN_MAX_ATTEMPTS', 8),
      windowSeconds: number('PASSWORD_LOGIN_WINDOW_SECONDS', 15 * 60),
    },
    supersetEmbed: readSupersetEmbedConfig(),
    rustfs: readRustfsConfig(),
    trino: readTrinoConfig(),
  };
}

/**
 * Parses "key1=uuid1,key2=uuid2" into a Map -- the same "key=value" shape
 * config/superset/bootstrap_embed.py prints and SUPERSET_EMBED_DASHBOARD_SLUGS
 * already uses, so there's one format to remember, not two. One malformed
 * entry does not take the rest down -- it is dropped with a warning, since an
 * operator hand-edits this value and a stray comma should not disable every
 * other already-working dashboard.
 */
function parseDashboardMap(raw: string): Map<string, string> {
  const dashboards = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0 || separator === trimmed.length - 1) {
      console.warn(`[auth] ignoring malformed SUPERSET_EMBED_DASHBOARDS entry: ${trimmed}`);
      continue;
    }
    dashboards.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return dashboards;
}

function readSupersetEmbedConfig(): AppConfig['supersetEmbed'] {
  const publicOrigin = optional('SUPERSET_EMBED_ORIGIN');
  const servicePassword = optional('SUPERSET_EMBED_SERVICE_PASSWORD');
  const dashboardsRaw = optional('SUPERSET_EMBED_DASHBOARDS');
  if (!publicOrigin || !servicePassword || !dashboardsRaw) {
    return undefined;
  }
  const dashboards = parseDashboardMap(dashboardsRaw);
  if (dashboards.size === 0) {
    return undefined;
  }
  return {
    // Not the browser-facing origin: this process calls Superset over the
    // compose network, where "localhost" would mean this container, not
    // Superset's.
    internalOrigin: (optional('SUPERSET_EMBED_INTERNAL_ORIGIN') ?? 'http://superset:8088').replace(/\/+$/, ''),
    publicOrigin: publicOrigin.replace(/\/+$/, ''),
    serviceUsername: optional('SUPERSET_EMBED_SERVICE_USERNAME') ?? 'psu-embed',
    servicePassword,
    dashboards,
  };
}

function readRustfsConfig(): AppConfig['rustfs'] {
  const accessKey = optional('RUSTFS_ACCESS_KEY');
  const secretKey = optional('RUSTFS_SECRET_KEY');
  if (!accessKey || !secretKey) {
    return undefined;
  }
  return {
    endpoint: optional('RUSTFS_ENDPOINT') ?? 'http://rustfs:9000',
    // RustFS has no real AWS region, but the S3 SDK always requires one --
    // placeholder, matches config/trino/catalog/hive.properties and
    // polaris.properties, which hit the same requirement against this same
    // storage.
    region: 'us-west-2',
    accessKey,
    secretKey,
    bucket: optional('RUSTFS_BUCKET') ?? 'psu-lakehouse',
  };
}

function readTrinoConfig(): AppConfig['trino'] {
  const password = optional('TRINO_INGESTION_PASSWORD');
  if (!password) {
    return undefined;
  }
  return {
    endpoint: optional('TRINO_ENDPOINT') ?? 'https://trino:8443',
    username: optional('TRINO_INGESTION_USERNAME') ?? 'nifi',
    password,
  };
}
