/**
 * PSU Passport is an OpenID Connect provider, so the authorization-code flow
 * with PKCE is handled by openid-client rather than written here. Nothing in
 * this file constructs or validates a token by hand.
 */
import * as client from 'openid-client';

import type { AppConfig } from './config.js';

/** The subset of AppConfig this module needs, with oidc narrowed to defined. */
type OidcAppConfig = Omit<AppConfig, 'oidc'> & { oidc: NonNullable<AppConfig['oidc']> };

export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  createdAt: number;
}

export interface OidcClaims {
  subject: string;
  username: string | undefined;
  displayName: string | undefined;
  email: string | undefined;
  campusCode: string | undefined;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
/** A browser that keeps starting logins and never finishing them cannot grow this without bound. */
const PENDING_MAX = 500;

export class OidcProvider {
  private constructor(
    private readonly discovered: client.Configuration,
    private readonly config: OidcAppConfig,
  ) {}

  /**
   * Discovery happens once at start-up, so a bad issuer fails fast and
   * loudly. Callers must check config.oidc themselves; this never runs for a
   * deployment with no registered client, so server.ts only calls it when
   * config.oidc is present.
   */
  static async create(config: OidcAppConfig): Promise<OidcProvider> {
    const discovered = await client.discovery(
      new URL(config.oidc.issuer),
      config.oidc.clientId,
      config.oidc.clientSecret,
    );
    return new OidcProvider(discovered, config);
  }

  private readonly pending = new Map<string, PendingLogin>();

  get redirectUri(): string {
    return `${this.config.publicOrigin}${this.config.oidc.callbackPath}`;
  }

  /** Starts a login and returns the handle the browser must send back. */
  async begin(next: string): Promise<{ handle: string; url: URL }> {
    this.evictStale();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const handle = client.randomState();

    this.pending.set(handle, { state, nonce, codeVerifier, next, createdAt: Date.now() });

    const url = client.buildAuthorizationUrl(this.discovered, {
      redirect_uri: this.redirectUri,
      scope: this.config.oidc.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { handle, url };
  }

  take(handle: string | undefined): PendingLogin | undefined {
    if (!handle) {
      return undefined;
    }
    const entry = this.pending.get(handle);
    // Single use: a replayed callback finds nothing.
    this.pending.delete(handle);
    if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) {
      return undefined;
    }
    return entry;
  }

  /**
   * Completes the exchange. openid-client verifies the issuer, audience,
   * signature, nonce and state; a mismatch throws and the caller fails closed.
   */
  async complete(currentUrl: URL, pending: PendingLogin): Promise<OidcClaims> {
    const tokens = await client.authorizationCodeGrant(this.discovered, currentUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
    });

    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error('the identity provider returned no subject');
    }

    const readString = (name: string): string | undefined => {
      const value = (claims as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }
      if (typeof value === 'number') {
        return String(value);
      }
      return undefined;
    };

    return {
      subject: claims.sub,
      username: readString(this.config.oidc.usernameClaim) ?? readString('sub'),
      displayName: readString(this.config.oidc.nameClaim),
      email: readString(this.config.oidc.emailClaim),
      campusCode: this.config.oidc.campusClaim
        ? readNested(claims as Record<string, unknown>, this.config.oidc.campusClaim)
        : undefined,
    };
  }

  endSessionUrl(idTokenHint?: string): URL | undefined {
    if (!this.config.oidc.postLogoutRedirect) {
      return undefined;
    }
    try {
      return client.buildEndSessionUrl(this.discovered, {
        post_logout_redirect_uri: this.config.oidc.postLogoutRedirect,
        ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
      });
    } catch {
      // Not every deployment publishes an end-session endpoint. Signing out of
      // this portal must still work when it does not.
      return undefined;
    }
  }

  private evictStale(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [handle, entry] of this.pending) {
      if (entry.createdAt < cutoff) {
        this.pending.delete(handle);
      }
    }
    while (this.pending.size >= PENDING_MAX) {
      const oldest = this.pending.keys().next();
      if (oldest.done) {
        break;
      }
      this.pending.delete(oldest.value);
    }
  }
}

/** Reads a claim by a dotted path, because claim names are deployment specific. */
function readNested(claims: Record<string, unknown>, path: string): string | undefined {
  const segments = path.split('.');
  let node: unknown = claims;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node === 'string' && node.trim() !== '') {
    return node.trim();
  }
  if (typeof node === 'number') {
    return String(node);
  }
  return undefined;
}
