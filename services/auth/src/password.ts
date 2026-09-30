/**
 * Email-and-password sign-in.
 *
 * Accounts are provisioned by an administrator (scripts/create-password-account.sh),
 * never through a public sign-up form -- there is no route in server.ts that
 * inserts a password_hash. This module only ever verifies one.
 */
import bcrypt from 'bcryptjs';

/**
 * A hash that never matches any real password. Used so a login attempt for an
 * email that does not exist still costs a bcrypt comparison, at the same cost
 * factor as a real one. Without this, the response time itself would tell an
 * attacker whether the email is registered -- the same class of leak
 * comparePassword.ts.md warns about in the reference implementation this was
 * adapted from, closed here rather than carried over.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO4Yz/0ihmYK/z1p60EBUOSpVKY.5Y7cO';

export async function hashPassword(plain: string, cost: number): Promise<string> {
  return bcrypt.hash(plain, cost);
}

/**
 * Verifies a password against a stored hash. Pass `undefined` for an account
 * that has none (PSU Passport-only, or one the lookup did not find) --
 * verification still runs against the dummy hash so the two cases cost the
 * same wall-clock time and always return false.
 */
export async function verifyPassword(plain: string, hash: string | undefined | null): Promise<boolean> {
  return bcrypt.compare(plain, hash ?? DUMMY_HASH);
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * A per-process, in-memory limiter: fine for this single-instance service,
 * and explicitly not a substitute for one that survives a restart or spans
 * multiple instances. See docs/AUTH_PSU_PASSPORT_TH.md for what that implies.
 *
 * Keyed by email rather than by IP: the thing worth slowing down is guessing
 * one account's password, which an IP-based limit does not stop from behind a
 * shared address, and does stop for the one thing that matters here.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowSeconds: number,
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStart > this.windowSeconds * 1000) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (entry.count < this.maxAttempts) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.ceil(
      (entry.windowStart + this.windowSeconds * 1000 - now) / 1000,
    );
    return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
  }

  /** Call after a failed attempt. A successful login clears the key instead. */
  recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStart > this.windowSeconds * 1000) {
      this.attempts.set(key, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  /** Keeps the map from growing forever on a long-running process. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) {
      if (now - entry.windowStart > this.windowSeconds * 1000) {
        this.attempts.delete(key);
      }
    }
  }
}
