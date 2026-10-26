import type { AppProps } from 'next/app';
import Head from 'next/head';
import { I18nProvider } from '@/i18n';
import { AuthProvider } from '@/lib/auth';
import { ConfigProvider } from '@/lib/config';
import '@/styles/globals.css';

/**
 * Providers live here so they survive client-side navigation: the session,
 * the chosen language and the deployment config are read once per tab, not
 * once per page.
 */
export default function PortalApp({ Component, pageProps }: AppProps) {
  return (
    <ConfigProvider>
      <I18nProvider>
        <AuthProvider>
          <Head>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
          </Head>
          <Component {...pageProps} />
        </AuthProvider>
      </I18nProvider>
    </ConfigProvider>
  );
}
