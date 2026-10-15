/*
 * Who is signed in, read once from psu-auth's /auth/me and kept for the life
 * of the tab. Client-side navigation between pages reuses it, which is what
 * keeps the header from blanking and refilling on every menu click.
 *
 * `available: false` means sign-in is not configured on this deployment or
 * psu-auth is down: the portal hides sign-in controls rather than showing one
 * that cannot work.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { knownTier } from './tiers';
import type { AccessTier } from './tiers';

/** What psu-auth's publicProfile() returns. Nothing more is sent. */
export interface PortalUser {
  username: string | null;
  displayName: string | null;
  userType: string | null;
  campusNameTh: string | null;
  facultyNameTh: string | null;
  departmentNameTh: string | null;
  accessTier: AccessTier;
  orgUnit: string | null;
}

export type AuthStatus = 'loading' | 'ready';

interface AuthValue {
  status: AuthStatus;
  available: boolean;
  user: PortalUser | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

function toUser(raw: unknown): PortalUser | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null);
  return {
    username: text('username'),
    displayName: text('displayName'),
    userType: text('userType'),
    campusNameTh: text('campusNameTh'),
    facultyNameTh: text('facultyNameTh'),
    departmentNameTh: text('departmentNameTh'),
    accessTier: knownTier(value.accessTier),
    orgUnit: text('orgUnit'),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [available, setAvailable] = useState(false);
  const [user, setUser] = useState<PortalUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/auth/me', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(`auth/me returned ${response.status}`);
      }
      const body = (await response.json()) as { authenticated?: boolean; user?: unknown };
      setAvailable(true);
      setUser(body.authenticated ? toUser(body.user) : null);
    } catch {
      setAvailable(false);
      setUser(null);
    } finally {
      setStatus('ready');
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const body = response.ok ? ((await response.json()) as { endSessionUrl?: string | null }) : null;
      if (body?.endSessionUrl) {
        window.location.href = body.endSessionUrl;
        return;
      }
    } catch {
      // Falls through: the home page shows whether the session is gone.
    }
    // A full load, not a client navigation: nothing from the signed-in
    // session should survive in memory.
    window.location.href = '/';
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ status, available, user, refresh, signOut }),
    [status, available, user, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}

/** /login with a `next` back to where the reader is now. */
export function signInHref(next?: string): string {
  const target = next ?? (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search);
  return `/login?next=${encodeURIComponent(target)}`;
}
