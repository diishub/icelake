/*
 * The dedicated sign-in page.
 *
 * Two independent paths converge on the same session: PSU Passport (a
 * redirect to /auth/login, handled entirely by services/auth) and email and
 * password (a JSON POST to /auth/password/login, handled here). Neither path
 * is assumed to be available -- this page checks /auth/health first and
 * degrades the PSU Passport button rather than offering a link that 503s.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { Brand } from '@/components/Brand';
import { GovBar } from '@/components/GovBar';
import { PasswordInput } from '@/components/PasswordInput';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/i18n';
import type { MessageKey, Replacements } from '@/i18n';

const OLD_PAGES = new Set(['upload', 'review', 'publish', 'reports', 'admin']);

/**
 * Only a same-site path is ever accepted, matching the server-side rule in
 * services/auth/src/http.ts (safeNextPath): a value naming a host is replaced
 * with the site root rather than "corrected".
 */
function safeNext(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return '/';
  }
  if (/[\\\r\n]/.test(candidate)) {
    return '/';
  }
  // Links and bookmarks from the old portal still carry "/admin.html" etc.
  const cut = candidate.search(/[?#]/);
  const path = cut === -1 ? candidate : candidate.slice(0, cut);
  const rest = cut === -1 ? '' : candidate.slice(cut);
  if (path === '/index.html') {
    return `/${rest}`;
  }
  const old = /^\/([a-z]+)\.html$/.exec(path);
  if (old?.[1] && OLD_PAGES.has(old[1])) {
    return `/${old[1]}${rest}`;
  }
  return candidate;
}

interface FormError {
  key: MessageKey;
  replacements?: Replacements;
}

/** null while /auth/health is answering. */
type Passport = 'ready' | 'off' | null;

export default function LoginPage() {
  const { t } = useI18n();
  const { status, available, user } = useAuth();
  const router = useRouter();

  const [next, setNext] = useState('/');
  const [passport, setPassport] = useState<Passport>(null);
  const [showPassportNote, setShowPassportNote] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const noteRef = useRef<HTMLParagraphElement>(null);

  // Read in an effect: the page is prerendered without a query string.
  useEffect(() => {
    if (router.isReady) {
      const raw = router.query.next;
      setNext(safeNext(typeof raw === 'string' ? raw : null));
    }
  }, [router.isReady, router.query.next]);

  const signedIn = status === 'ready' && available && user !== null;
  const unavailable = status === 'ready' && !available;

  // A signed-in visitor is sent straight to "next" rather than shown a login
  // form they no longer need.
  useEffect(() => {
    if (signedIn && router.isReady) {
      window.location.replace(next);
    }
  }, [signedIn, router.isReady, next]);

  useEffect(() => {
    if (status !== 'ready' || !available || user) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/auth/health', { cache: 'no-store', credentials: 'same-origin' });
        const body = response.ok ? ((await response.json()) as { psuPassport?: boolean }) : {};
        if (!cancelled) setPassport(body.psuPassport ? 'ready' : 'off');
      } catch {
        if (!cancelled) setPassport('off');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, available, user]);

  useEffect(() => {
    if (showPassportNote) {
      noteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [showPassportNote]);

  // When PSU Passport is not configured (e.g. localhost development) the
  // button stays visible, and a click explains why it does nothing.
  function onPassportClick(event: MouseEvent<HTMLAnchorElement>) {
    if (passport === 'ready') {
      return;
    }
    event.preventDefault();
    if (passport === 'off') {
      setShowPassportNote(true);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Read straight from the form so the password is never held in state.
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!email || !password) {
      setError({ key: 'login.errorInvalidRequest' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/auth/password/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, next }),
      });

      if (response.ok) {
        const body = (await response.json()) as { next?: string };
        // A full load, so the AuthProvider reads the new session.
        window.location.assign(safeNext(body.next || next));
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        retryAfterSeconds?: number;
      };
      if (response.status === 429) {
        const header = Number(response.headers.get('Retry-After'));
        const seconds = body.retryAfterSeconds ?? (Number.isFinite(header) && header > 0 ? header : 60);
        setError({ key: 'login.errorRateLimited', replacements: { seconds } });
      } else if (response.status === 403 && body.error === 'account_disabled') {
        setError({ key: 'login.errorAccountDisabled' });
      } else if (response.status === 401) {
        setError({ key: 'login.errorInvalidCredentials' });
      } else if (response.status === 400) {
        setError({ key: 'login.errorInvalidRequest' });
      } else {
        setError({ key: 'login.errorGeneric' });
      }
    } catch {
      setError({ key: 'login.serviceUnavailable' });
    } finally {
      setSubmitting(false);
    }
  }

  const statusKey: MessageKey | null =
    status === 'loading' ? 'login.checking' : signedIn ? 'login.alreadySignedIn' : null;
  // psu-auth unreachable: nothing on this page can work, so say so on the form.
  const shownError: FormError | null = unavailable ? { key: 'login.serviceUnavailable' } : error;
  const disabled = unavailable || submitting;

  return (
    <div className="app-shell">
      <Head>
        <title>{t('login.pageTitle')}</title>
      </Head>
      <a className="skip-link" href="#login-main">
        {t('skip')}
      </a>
      <GovBar />
      <header className="site-header">
        <div className="container site-header-inner">
          <Brand />
        </div>
      </header>

      <main id="login-main" className="login-main">
        <div className="login-card">
          <p className="login-status" role="status" aria-live="polite" hidden={!statusKey}>
            {statusKey ? t(statusKey) : null}
          </p>

          <div hidden={statusKey !== null}>
            <h1 className="login-heading">{t('login.heading')}</h1>
            <p className="login-subheading">{t('login.subheading')}</p>

            <p className="login-note login-note-warning" ref={noteRef} hidden={!showPassportNote}>
              {t('login.psuPassportUnavailable')}
            </p>

            <a
              className="login-psu-button"
              href={passport === 'ready' ? `/auth/login?next=${encodeURIComponent(next)}` : '#'}
              role="button"
              hidden={unavailable}
              onClick={onPassportClick}
            >
              <div className="login-psu-button-content">
                <div className="login-psu-logo-container">
                  <img src="/assets/psu-logo.png" alt="" className="login-psu-logo-img" />
                </div>
                <div className="login-psu-text-group">
                  <span className="login-psu-eyebrow">PSU PASSPORT</span>
                  <span className="login-psu-title">{t('login.psuPassportButton')}</span>
                </div>
              </div>
              <div className="login-psu-action-icon" aria-hidden="true">
                <svg
                  className="login-psu-arrow"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </div>
            </a>

            <div className="login-divider" hidden={unavailable}>
              <span>{t('login.divider')}</span>
            </div>

            <form className="login-form" noValidate onSubmit={onSubmit}>
              <p className="login-error" role="alert" hidden={!shownError}>
                {shownError ? t(shownError.key, shownError.replacements) : null}
              </p>

              <div className="login-field">
                <label htmlFor="login-email">{t('login.emailLabel')}</label>
                <input
                  type="email"
                  id="login-email"
                  name="email"
                  required
                  autoComplete="username"
                  inputMode="email"
                  placeholder={t('login.emailPlaceholder')}
                  disabled={unavailable}
                />
              </div>

              <div className="login-field">
                <label htmlFor="login-password">{t('login.passwordLabel')}</label>
                <PasswordInput
                  id="login-password"
                  name="password"
                  required
                  autoComplete="current-password"
                  disabled={unavailable}
                />
              </div>

              <button className="button button-secondary login-submit" type="submit" disabled={disabled}>
                {submitting ? t('login.submitting') : t('login.submit')}
              </button>
            </form>

            <p className="login-note">{t('login.noAccountNote')}</p>
          </div>
        </div>

        <Link className="login-back" href="/">
          {t('login.backHome')}
        </Link>
      </main>

      <footer className="app-footer">
        <p className="container">{t('app.footer')}</p>
      </footer>
    </div>
  );
}
