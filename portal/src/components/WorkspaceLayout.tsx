import Head from 'next/head';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { canOpen } from '@/lib/tiers';
import type { WorkspacePage } from '@/lib/tiers';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { AccountCard } from './AccountCard';
import { Brand } from './Brand';
import { GovBar } from './GovBar';

const NAV: { page: WorkspacePage; href: string; label: MessageKey }[] = [
  { page: 'upload', href: '/upload', label: 'ws.upload' },
  { page: 'review', href: '/review', label: 'ws.review' },
  { page: 'publish', href: '/publish', label: 'ws.publish' },
  { page: 'reports', href: '/reports', label: 'ws.reports' },
  { page: 'admin', href: '/admin', label: 'ws.admin' },
];

interface Props {
  page: WorkspacePage;
  /** Browser tab title, before " · PSU Data Hub". */
  title: MessageKey;
  description?: MessageKey;
  mainId: string;
  children: ReactNode;
}

/**
 * Shared frame of the workspace pages: gov bar, header, workspace menu,
 * footer. The menu lists only the pages the signed-in tier can open; the
 * current page is always listed.
 */
export function WorkspaceLayout({ page, title, description, mainId, children }: Props) {
  const { t } = useI18n();
  const { user } = useAuth();

  return (
    <div className="app-shell">
      <Head>
        <title>{`${t(title)} · PSU Data Hub`}</title>
        {description ? <meta name="description" content={t(description)} /> : null}
      </Head>
      <a className="skip-link" href={`#${mainId}`}>
        {t('skip')}
      </a>
      <GovBar />
      <header className="site-header">
        <div className="container site-header-inner">
          <Brand tagline="ws.subtitle" />
          <AccountCard />
        </div>
        <div className="container">
          <nav className="workspace-nav" aria-label={t('ws.label')}>
            <Link href="/">{t('ws.home')}</Link>
            {NAV.filter((item) => item.page === page || canOpen(item.page, user?.accessTier)).map((item) => (
              <Link key={item.page} href={item.href} aria-current={item.page === page ? 'page' : undefined}>
                {t(item.label)}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id={mainId} className="container page">
        {children}
      </main>
      <footer className="app-footer">
        <p className="container">{t('app.footer')}</p>
      </footer>
    </div>
  );
}
