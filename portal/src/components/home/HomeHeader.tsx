import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AccountCard } from '@/components/AccountCard';
import { Brand } from '@/components/Brand';
import { GovBar } from '@/components/GovBar';
import { signInHref, useAuth } from '@/lib/auth';
import { canOpen } from '@/lib/tiers';
import { useI18n } from '@/i18n';
import { localeOf } from './CatalogSection';

type ReportStatus = { state: 'is-checking' } | { state: 'is-ready' | 'is-down'; checkedAt: Date };

/** Reachability of the reporting system, from psu-auth's /api/health/reports. */
function ReportStatusPill() {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<ReportStatus>({ state: 'is-checking' });

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    let cancelled = false;
    fetch('/api/health/reports', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`health returned ${response.status}`);
        }
        if (!cancelled) setStatus({ state: 'is-ready', checkedAt: new Date() });
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: 'is-down', checkedAt: new Date() });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  let title: string;
  let detail: string | undefined;
  if (status.state === 'is-checking') {
    title = t('status.checking');
  } else {
    title = t(status.state === 'is-ready' ? 'status.ready' : 'status.down');
    let time: string;
    try {
      time = new Intl.DateTimeFormat(localeOf(language), { hour: '2-digit', minute: '2-digit' }).format(
        status.checkedAt,
      );
    } catch {
      time = t('status.checkedNow');
    }
    detail = t('status.checkedAt', { time });
  }

  return (
    <div className={`service-status ${status.state}`} id="report-status" role="status" aria-live="polite" title={detail}>
      <span className="status-dot" aria-hidden="true" />
      <strong>{title}</strong>
      <small hidden />
    </div>
  );
}

// --- PSU Passport sign-in -------------------------------------------------
//
// The portal holds no credential and runs no part of the OpenID flow: it asks
// /auth/me who is signed in (useAuth), and links to /login to start. Both are
// proxied same-origin to the psu-auth service, so the session cookie stays
// HttpOnly and this page never sees a token.
//
// When psu-auth is not running, /auth/me fails and every control below stays
// hidden. A sign-in button that cannot work is worse than none.
function HomeAccount() {
  const { t } = useI18n();
  const { available, user } = useAuth();
  const tier = user?.accessTier;

  // `available` only turns true after /auth/me answers in the browser, so
  // window is safe to read whenever the contents are rendered.
  return (
    <div className="account" id="account" hidden={!available}>
      {available ? (
        <>
          {user ? null : (
            <a
              className="button button-primary"
              id="account-signin"
              href={signInHref(window.location.pathname + window.location.search + window.location.hash)}
            >
              {t('account.signIn')}
            </a>
          )}
          <div className="account-links">
            {canOpen('upload', tier) ? (
              <Link id="account-upload-link" href="/upload">
                {t('account.uploadLink')}
              </Link>
            ) : null}
            {canOpen('review', tier) ? (
              <Link id="account-review-link" href="/review">
                {t('account.reviewLink')}
              </Link>
            ) : null}
            {/* Analysts ask for releases; stewards approve their own unit's. */}
            {canOpen('publish', tier) ? (
              <Link id="account-publish-link" href="/publish">
                {t('account.publishLink')}
              </Link>
            ) : null}
            {canOpen('admin', tier) ? (
              <Link id="account-admin-link" href="/admin">
                {t('account.adminLink')}
              </Link>
            ) : null}
          </div>
          {/* The granted tier, then the directory's faculty: a password account has no directory record. */}
          <AccountCard unit="directory" />
        </>
      ) : null}
    </div>
  );
}

export function HomeHeader() {
  const { t } = useI18n();
  return (
    <>
      <GovBar>
        <ReportStatusPill />
      </GovBar>
      <header className="site-header" id="top">
        <div className="container site-header-inner">
          <Brand />
          <nav className="main-nav" aria-label={t('nav.label')}>
            <a href="#catalog">{t('nav.catalog')}</a>
            <a href="#access">{t('nav.access')}</a>
            <a href="#governance">{t('nav.governance')}</a>
            <a href="#help">{t('nav.help')}</a>
          </nav>
          <HomeAccount />
        </div>
      </header>
    </>
  );
}
