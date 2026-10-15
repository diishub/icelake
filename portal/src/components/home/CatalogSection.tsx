import Link from 'next/link';
import { useI18n } from '@/i18n';
import type { Language } from '@/i18n';
import { availabilityOf } from './useCatalog';
import type { CatalogDataset, CatalogDomain, CatalogStatKey, CatalogState } from './useCatalog';

type T = ReturnType<typeof useI18n>;

export const localeOf = (language: Language) => (language === 'en' ? 'en-GB' : 'th-TH');

/** Title and description in the active language, falling back to Thai. */
const datasetTitle = (dataset: CatalogDataset, language: Language) =>
  (language === 'en' ? dataset.title_en : dataset.title) || dataset.title;
const datasetDescription = (dataset: CatalogDataset, language: Language) =>
  (language === 'en' ? dataset.description_en : dataset.description) || dataset.description;
const domainLabel = (domain: CatalogDomain, language: Language) =>
  (language === 'en' ? domain.label_en : domain.label) || domain.label;

function formatDateTime(isoString: string | null | undefined, language: Language): string | null {
  if (!isoString) {
    return null;
  }
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat(localeOf(language), { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
  } catch {
    return parsed.toISOString().slice(0, 16).replace('T', ' ');
  }
}

// Age matters more than the timestamp for freshness, and "8 วันที่แล้ว" is
// read faster than a date the reader has to subtract from today.
function formatAge(isoString: string | null | undefined, t: T['t']): string {
  if (!isoString) {
    return t('age.never');
  }
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return t('age.unknown');
  }
  const minutes = Math.round((Date.now() - parsed.getTime()) / 60000);
  if (minutes < 60) {
    return t('age.minutes', { count: Math.max(minutes, 0) });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('age.hours', { count: hours });
  }
  return t('age.days', { count: Math.round(hours / 24) });
}

function matchesQuery(dataset: CatalogDataset, query: string, domains: CatalogDomain[]): boolean {
  if (!query) {
    return true;
  }
  const domain = domains.find((d) => d.key === dataset.domain);
  // Both languages are searched whichever one is on screen, so an English
  // reader who knows the Thai name still finds the dataset.
  const haystack = [
    dataset.title,
    dataset.description,
    dataset.title_en,
    dataset.description_en,
    dataset.key,
    dataset.owner,
    dataset.source,
    domain?.label,
    domain?.label_en,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/** A figure from catalog.stats, or a dash while it is unknown. */
export function CatalogStat({ catalog, name }: { catalog: CatalogState; name: CatalogStatKey }) {
  const { language } = useI18n();
  const value = catalog.status === 'ready' ? catalog.document.stats?.[name] : undefined;
  return <>{typeof value === 'number' ? value.toLocaleString(localeOf(language)) : '—'}</>;
}

export function catalogGenerated(catalog: CatalogState, { t, language }: T): string {
  if (catalog.status === 'loading') {
    return t('stats.reading');
  }
  if (catalog.status === 'error') {
    return t('stats.notPublished');
  }
  const stamp = formatDateTime(catalog.document.generated_at, language);
  return stamp ? t('stats.generatedAt', { time: stamp }) : t('stats.generatedUnknown');
}

function DatasetItem({ dataset, domains }: { dataset: CatalogDataset; domains: CatalogDomain[] }) {
  const { t, tx, language } = useI18n();
  const availability = availabilityOf(dataset.availability);
  const modifier = `is-${availability}`;
  const description = datasetDescription(dataset, language);
  const domain = domains.find((d) => d.key === dataset.domain);
  const facts: [string, string][] = [];
  if (domain) {
    facts.push([t('catalog.domain'), domainLabel(domain, language)]);
  }
  facts.push([t('catalog.owner'), dataset.owner ?? '']);
  facts.push([t('catalog.updated'), formatAge(dataset.last_success_at, t)]);
  if (typeof dataset.column_count === 'number' && dataset.column_count > 0) {
    facts.push([
      t('catalog.columns'),
      t('catalog.columnsValue', { safe: String(dataset.safe_column_count), total: dataset.column_count }),
    ]);
  }
  facts.push([t('catalog.loadMode'), tx(`loadMode.${dataset.load_mode}`)]);

  return (
    <li className={`catalog-item ${modifier}`}>
      <div className="catalog-item-head">
        <h3>{datasetTitle(dataset, language)}</h3>
        <span className={`state-badge ${modifier}`}>{tx(`availability.${availability}`)}</span>
      </div>
      <p className="catalog-key">{dataset.key}</p>
      {description ? <p className="catalog-description">{description}</p> : null}
      <dl className="catalog-facts">
        {facts.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {/*
        /reports is the tier-gated page that embeds the live dashboard; it does
        its own "not signed in yet" redirect with the right destination, so
        this link is not rewritten to a sign-in link here (that would only know
        how to send an anonymous visitor back to *this* page).
      */}
      {availability === 'published' ? (
        <Link className="text-link catalog-action" href="/reports">
          {t('catalog.openReport')}
        </Link>
      ) : (
        <a className="text-link catalog-action" href="#request-data">
          {t('catalog.requestAccess')}
        </a>
      )}
    </li>
  );
}

interface Props {
  catalog: CatalogState;
  query: string;
  domain: string | null;
  onDomain: (domain: string | null) => void;
  onClear: () => void;
}

export function CatalogSection({ catalog, query, domain, onDomain, onClear }: Props) {
  const { t, language } = useI18n();
  const ready = catalog.status === 'ready' ? catalog : null;
  const datasets = ready?.datasets ?? [];
  const domains = ready?.domains ?? [];

  const visible = datasets.filter(
    (dataset) => (!domain || dataset.domain === domain) && matchesQuery(dataset, query, domains),
  );
  const filtered = Boolean(domain || query);

  let count: string;
  if (catalog.status === 'loading') {
    count = t('catalog.loading');
  } else if (catalog.status === 'error') {
    count = t('catalog.none');
  } else {
    count = filtered
      ? t('catalog.countFiltered', { visible: visible.length, total: datasets.length })
      : t('catalog.countAll', { total: datasets.length });
  }

  const option = (key: string | null, label: string, n: number | undefined) => (
    <button
      key={key ?? ''}
      className="domain-card"
      type="button"
      aria-pressed={domain === key}
      onClick={() => onDomain(key)}
    >
      <strong>{label}</strong>
      <span className="domain-count">{n ?? ''}</span>
    </button>
  );

  return (
    <section className="container home-section" id="catalog" aria-labelledby="catalog-title">
      <div className="section-head">
        <div>
          <h2 id="catalog-title">{t('catalog.title')}</h2>
          <p>{t('catalog.lead')}</p>
        </div>
        <a className="text-link" href="#request-data">
          {t('catalog.notFound')}
        </a>
      </div>

      <div className="catalog-layout">
        <div className="filter-panel">
          <h3 className="filter-heading" id="domain-heading">
            {t('domains.heading')}
          </h3>
          <div className="domain-grid" id="domain-grid" role="group" aria-labelledby="domain-heading">
            {catalog.status === 'loading' ? <p className="domain-placeholder">{t('domains.loading')}</p> : null}
            {ready
              ? [
                  option(null, t('domains.all'), datasets.length),
                  ...domains.map((d) => option(d.key, domainLabel(d, language), d.dataset_count)),
                ]
              : null}
          </div>
        </div>

        <div className="catalog-results">
          <div className="catalog-toolbar">
            <p className="catalog-count" id="catalog-count" role="status" aria-live="polite">
              {count}
            </p>
            <button
              className="button button-ghost button-small"
              type="button"
              id="catalog-clear"
              hidden={!ready || !filtered}
              onClick={onClear}
            >
              {t('catalog.clear')}
            </button>
          </div>
          <ul className="catalog-list" id="catalog-list" aria-labelledby="catalog-title">
            {visible.map((dataset) => (
              <DatasetItem key={dataset.key} dataset={dataset} domains={domains} />
            ))}
          </ul>
          <p className="catalog-empty" id="catalog-empty" hidden={!ready || visible.length > 0}>
            {t('catalog.empty')}
          </p>
          <p className="catalog-error" id="catalog-error" hidden={catalog.status !== 'error'}>
            <span>{t('catalog.errorPrefix')}</span> <code>scripts/publish-portal-catalog.sh</code>{' '}
            <span>{t('catalog.errorSuffix')}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
