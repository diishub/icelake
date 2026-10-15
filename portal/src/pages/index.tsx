import Head from 'next/head';
import { useEffect, useRef, useState } from 'react';
import { CatalogSection, CatalogStat, catalogGenerated } from '@/components/home/CatalogSection';
import { HomeFooter, ToTop } from '@/components/home/HomeFooter';
import { HomeHeader } from '@/components/home/HomeHeader';
import { AccessSection, GovernanceSection, RequestAndHelpSection } from '@/components/home/InfoSections';
import { Intro } from '@/components/home/Intro';
import { useCatalog } from '@/components/home/useCatalog';
import type { CatalogStatKey } from '@/components/home/useCatalog';
import { usePortalConfig } from '@/lib/config';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

const STATS: [CatalogStatKey, MessageKey][] = [
  ['datasets_total', 'stats.total'],
  ['datasets_published', 'stats.published'],
  ['data_owners', 'stats.owners'],
  ['columns_withheld', 'stats.withheld'],
];

function focusCatalog() {
  document.querySelector('#catalog')?.scrollIntoView({ block: 'start' });
}

export default function HomePage() {
  const i18n = useI18n();
  const { t, pick } = i18n;
  const config = usePortalConfig();
  const catalog = useCatalog();

  // `input` follows the search box; `query` is what the list is filtered by.
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState<string | null>(null);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onInput = (value: string) => {
    setInput(value);
    window.clearTimeout(timer.current);
    // Debounced so a fast typist does not re-render on every keystroke, short
    // enough that the list still feels attached to the keyboard.
    timer.current = window.setTimeout(() => setQuery(value.trim()), 150);
  };

  const searchNow = (value: string) => {
    window.clearTimeout(timer.current);
    setQuery(value.trim());
    focusCatalog();
  };

  // Deployment copy may be a plain string or a per-language map. "Pilot" is
  // the old portal's built-in default, kept while /config.json is loading.
  const pilotLabel = pick(config.pilotLabel) || 'Pilot';
  const supportMessage = pick(config.supportMessage) || t('config.support');

  return (
    <>
      <Head>
        <title>{`PSU Data Hub · ${t('intro.title')}`}</title>
      </Head>
      <a className="skip-link" href="#main-content">
        {t('skip')}
      </a>

      <HomeHeader />

      <main id="main-content">
        <Intro
          pilotLabel={pilotLabel}
          input={input}
          onInput={onInput}
          onSubmit={() => searchNow(input)}
          onTerm={(term) => {
            setInput(term);
            searchNow(term);
          }}
        />

        <section className="container stats-section" aria-labelledby="stats-title">
          <h2 className="sr-only" id="stats-title">
            {t('stats.heading')}
          </h2>
          <div className="stats-strip">
            {STATS.map(([name, label]) => (
              <div className="stat-cell" key={name}>
                <strong>
                  <CatalogStat catalog={catalog} name={name} />
                </strong>
                <span>{t(label)}</span>
              </div>
            ))}
          </div>
          <p className="catalog-meta">{catalogGenerated(catalog, i18n)}</p>
        </section>

        <CatalogSection
          catalog={catalog}
          query={query}
          domain={domain}
          onDomain={setDomain}
          onClear={() => {
            window.clearTimeout(timer.current);
            setInput('');
            setQuery('');
            setDomain(null);
          }}
        />

        <AccessSection />
        <GovernanceSection catalog={catalog} />
        <RequestAndHelpSection supportMessage={supportMessage} />
      </main>

      <HomeFooter pilotLabel={pilotLabel} />
      <ToTop />
    </>
  );
}
