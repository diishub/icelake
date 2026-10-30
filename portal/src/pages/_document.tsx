import { Head, Html, Main, NextScript } from 'next/document';
import th from '@/i18n/th';

const PRELOADED_FONTS = ['sarabun-thai-400', 'sarabun-latin-400', 'sarabun-thai-700'];

/**
 * Prerendered in Thai, the default language; I18nProvider switches after
 * hydration. No inline script or style anywhere: nginx serves the export
 * under `script-src 'self'; style-src 'self'` (config/portal/default.conf.template).
 */
export default function Document() {
  return (
    <Html lang="th">
      <Head>
        <meta charSet="utf-8" />
        <meta name="description" content={th['meta.description']} />
        {PRELOADED_FONTS.map((font) => (
          <link
            key={font}
            rel="preload"
            href={`/fonts/${font}.woff2`}
            as="font"
            type="font/woff2"
            crossOrigin=""
          />
        ))}
      </Head>
      <body>
        <Main />
        <NextScript />
        <noscript>
          <div className="noscript-message">{th.noscript}</div>
        </noscript>
      </body>
    </Html>
  );
}
