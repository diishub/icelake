import { useEffect, useRef } from 'react';
import { useI18n } from '@/i18n';

export function HomeFooter({ pilotLabel }: { pilotLabel: string }) {
  const { t } = useI18n();
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <strong>PSU Data Hub</strong>
          <p>{t('footer.about')}</p>
        </div>
        <nav aria-label={t('footer.linksLabel')}>
          <a href="#catalog">{t('nav.catalog')}</a>
          <a href="#governance">{t('nav.governance')}</a>
          <a href="#help">{t('help.title')}</a>
        </nav>
        <div>
          <strong>{t('footer.contact')}</strong>
          <p>{t('footer.contactDetail')}</p>
        </div>
      </div>
      <div className="footer-bottom">
        <p className="container">
          <span>{t('footer.copyright')}</span> · <span>{pilotLabel}</span> · <span>{t('footer.meta')}</span>
        </p>
      </div>
    </footer>
  );
}

/** Shown once the reader is more than ~60% of a screen down the page. */
export function ToTop() {
  const { t } = useI18n();
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    let ticking = false;
    const sync = () => {
      ref.current?.classList.toggle('is-visible', window.scrollY > window.innerHeight * 0.6);
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(sync);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    sync();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <a className="to-top" href="#top" aria-label={t('toTop')} ref={ref}>
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
        <path d="m6 15 6-6 6 6" />
      </svg>
    </a>
  );
}
