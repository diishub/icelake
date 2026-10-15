import Head from 'next/head';
import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { GovBar } from '@/components/GovBar';
import { useI18n } from '@/i18n';

// Replaces Next's built-in 404, whose inline styles the portal CSP refuses.
export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="app-shell">
      <Head>
        <title>{`${t('notFound.title')} · PSU Data Hub`}</title>
      </Head>
      <GovBar />
      <header className="site-header">
        <div className="container site-header-inner">
          <Brand />
        </div>
      </header>
      <main id="main-content" className="container page">
        <h1 className="page-title">{t('notFound.title')}</h1>
        <p className="page-lead">{t('notFound.lead')}</p>
        <p>
          <Link className="button button-primary" href="/">
            {t('notFound.home')}
          </Link>
        </p>
      </main>
    </div>
  );
}
