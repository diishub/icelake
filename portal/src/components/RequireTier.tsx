import { useRouter } from 'next/router';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { signInHref, useAuth } from '@/lib/auth';
import type { PortalUser } from '@/lib/auth';
import { canOpen } from '@/lib/tiers';
import type { WorkspacePage } from '@/lib/tiers';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

interface Props {
  page: WorkspacePage;
  /** Shown to a signed-in account whose tier cannot open the page. */
  forbidden: MessageKey | ReactNode;
  /** Shown while /auth/me is answering. */
  checking?: MessageKey;
  children: (user: PortalUser) => ReactNode;
}

/**
 * Gate for a workspace page: waits for /auth/me, sends a signed-out reader to
 * /login with a way back, and tells a signed-in reader without the tier why
 * the page is closed to them. UX only -- psu-auth refuses the API calls too.
 */
export function RequireTier({ page, forbidden, checking = 'admin.checking', children }: Props) {
  const { status, available, user } = useAuth();
  const { t, tx } = useI18n();
  const router = useRouter();
  const signedOut = status === 'ready' && available && !user;

  useEffect(() => {
    if (signedOut) {
      void router.replace(signInHref(router.asPath));
    }
  }, [signedOut, router]);

  if (status === 'loading' || signedOut) {
    return (
      <p className="login-status" role="status" aria-live="polite">
        {t(checking)}
      </p>
    );
  }
  if (!available) {
    return (
      <p className="login-status is-error" role="status">
        {t('login.serviceUnavailable')}
      </p>
    );
  }
  if (!user || !canOpen(page, user.accessTier)) {
    // A page's own forbidden block may hold headings, which cannot sit in a <p>.
    return typeof forbidden === 'string' ? (
      <p className="login-status" role="status">
        {tx(forbidden)}
      </p>
    ) : (
      <>{forbidden}</>
    );
  }
  return <>{children(user)}</>;
}
