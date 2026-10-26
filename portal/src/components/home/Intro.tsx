import type { FormEvent } from 'react';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

const SEARCH_TERMS: MessageKey[] = ['search.term1', 'search.term2', 'search.term3', 'search.term4'];

interface Props {
  pilotLabel: string;
  input: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onTerm: (term: string) => void;
}

export function Intro({ pilotLabel, input, onInput, onSubmit, onTerm }: Props) {
  const { t } = useI18n();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="intro" aria-labelledby="intro-title">
      <div className="container intro-grid">
        <div className="intro-copy">
          <p className="pilot-label">{pilotLabel}</p>
          <h1 className="intro-title" id="intro-title">
            {t('intro.title')}
          </h1>
          <p className="intro-lead">{t('intro.lead')}</p>

          <form className="search-form" id="catalog-search-form" role="search" aria-label={t('search.label')} onSubmit={submit}>
            <label className="search-label" htmlFor="catalog-search">
              {t('search.label')}
            </label>
            <div className="search-row">
              <div className="search-field">
                <svg
                  className="icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  className="search-input"
                  id="catalog-search"
                  type="search"
                  name="q"
                  placeholder={t('search.placeholder')}
                  autoComplete="off"
                  enterKeyHint="search"
                  aria-describedby="search-hint"
                  value={input}
                  onChange={(event) => onInput(event.target.value)}
                />
              </div>
              <button className="button button-primary search-submit" type="submit">
                {t('search.submit')}
              </button>
            </div>
            <p className="search-hint" id="search-hint">
              {t('search.hint')}
            </p>
          </form>

          <div className="search-suggestions" aria-label={t('search.suggestionsLabel')}>
            <span>{t('search.tryPrefix')}</span>
            {/*
              The chip label is translated, so the term it searches for comes
              from the same dictionary rather than from the text on screen.
            */}
            {SEARCH_TERMS.map((key) => (
              <button key={key} className="link-button" type="button" onClick={() => onTerm(t(key))}>
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        <aside className="howto-card" aria-labelledby="howto-title">
          <h2 id="howto-title">{t('howto.title')}</h2>
          <ol className="howto-steps">
            {(
              [
                ['howto.step1', 'howto.step1Detail'],
                ['howto.step2', 'howto.step2Detail'],
                ['howto.step3', 'howto.step3Detail'],
              ] as const
            ).map(([step, detail], index) => (
              <li key={step}>
                <span className="step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span>
                  <strong>{t(step)}</strong>
                  <small>{t(detail)}</small>
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </section>
  );
}
