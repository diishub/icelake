import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { CatalogStat } from './CatalogSection';
import type { CatalogState } from './useCatalog';

const ROLES = [
  { role: 'viewer', href: '/reports' },
  { role: 'analyst', href: '/publish' },
  { role: 'steward', href: '/upload' },
  { role: 'operator', href: '/admin' },
] as const;

export function AccessSection() {
  const { t } = useI18n();
  return (
    <section className="container home-section" id="access" aria-labelledby="access-title">
      <div className="section-head">
        <div>
          <h2 id="access-title">{t('access.title')}</h2>
          <p>{t('access.lead')}</p>
        </div>
      </div>
      <div className="roles-grid">
        {ROLES.map(({ role, href }) => (
          <article className="role-card" key={role}>
            <h3>{t(`access.${role}.title`)}</h3>
            <p>{t(`access.${role}.description`)}</p>
            <Link className="text-link" href={href}>
              {t(`access.${role}.link`)}
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

export function GovernanceSection({ catalog }: { catalog: CatalogState }) {
  const { t } = useI18n();
  const rule = (index: MessageKey, title: MessageKey, detail: ReactNode) => (
    <li>
      <strong className="rule-index">{t(index)}</strong>
      <div>
        <h3>{t(title)}</h3>
        <p>{detail}</p>
      </div>
    </li>
  );
  return (
    <section className="container home-section" id="governance" aria-labelledby="governance-title">
      <div className="section-head">
        <div>
          <h2 id="governance-title">{t('governance.title')}</h2>
          <p>{t('governance.lead')}</p>
        </div>
      </div>
      <ol className="rules-list">
        {rule('governance.item1', 'governance.rule1', t('governance.rule1Detail'))}
        {rule(
          'governance.item2',
          'governance.rule2',
          <>
            <span>{t('governance.rule2Before')}</span>{' '}
            <strong className="rule-figure">
              <CatalogStat catalog={catalog} name="columns_withheld" />
            </strong>{' '}
            <span>{t('governance.rule2After')}</span>
          </>,
        )}
        {rule('governance.item3', 'governance.rule3', t('governance.rule3Detail'))}
        {rule('governance.item4', 'governance.rule4', t('governance.rule4Detail'))}
      </ol>
    </section>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.className = 'clipboard-helper';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('copy command was not available');
  }
}

const REQUEST_FIELDS = [1, 2, 3, 4, 5] as const;
const FAQ = [1, 2, 3, 4, 5] as const;

export function RequestAndHelpSection({ supportMessage }: { supportMessage: string }) {
  const { t } = useI18n();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copiedOnce, setCopiedOnce] = useState(false);

  const copyRequest = async () => {
    // Built when the button is pressed, not at load, so it is copied in the
    // language the reader is actually looking at.
    const template = [
      t('form.title'),
      '',
      t('form.line1'),
      t('form.line2'),
      t('form.line3'),
      t('form.line4'),
      t('form.line5'),
      t('form.line6'),
      '',
      t('form.note'),
    ].join('\n');
    try {
      await copyText(template);
      setCopy('copied');
      setCopiedOnce(true);
    } catch {
      setCopy('failed');
    }
  };

  return (
    <section className="container home-section two-column" aria-label={t('request.sectionLabel')}>
      <div id="request-data">
        <h2>{t('request.title')}</h2>
        <p>{t('request.lead')}</p>
        <dl className="request-template" aria-label={t('request.templateLabel')}>
          {REQUEST_FIELDS.map((n) => (
            <div key={n}>
              <dt>{t(`request.q${n}`)}</dt>
              <dd>{t(`request.a${n}`)}</dd>
            </div>
          ))}
        </dl>
        <div className="request-actions">
          <button className="button button-secondary" type="button" id="copy-request" onClick={() => void copyRequest()}>
            {t(copiedOnce ? 'request.copyButtonDone' : 'request.copy')}
          </button>
          <p className="copy-feedback" id="copy-feedback" role="status" aria-live="polite">
            {copy === 'copied' ? t('request.copied') : copy === 'failed' ? t('request.copyFailed') : ''}
          </p>
        </div>
      </div>

      <div id="help">
        <h2>{t('help.title')}</h2>
        <div className="faq-list">
          {FAQ.map((n) => (
            <details key={n}>
              <summary>{t(`help.q${n}`)}</summary>
              <p>{t(`help.a${n}`)}</p>
            </details>
          ))}
        </div>
        <p className="support-note">{supportMessage}</p>
      </div>
    </section>
  );
}
