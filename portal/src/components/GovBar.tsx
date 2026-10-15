import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';

/** The university strip at the top of every page, with the language switch. */
export function GovBar({ children }: { children?: ReactNode }) {
  const { t, toggle } = useI18n();
  return (
    <div className="gov-bar">
      <div className="container gov-bar-inner">
        <span>{t('gov.university')}</span>
        <div className="gov-bar-tools">
          {children}
          <button className="lang-switch" type="button" aria-label={t('lang.switchLabel')} onClick={toggle}>
            {t('lang.switchTo')}
          </button>
        </div>
      </div>
    </div>
  );
}
