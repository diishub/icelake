import Link from 'next/link';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

export function Brand({ tagline = 'brand.tagline' }: { tagline?: MessageKey }) {
  const { t } = useI18n();
  return (
    <Link className="brand" href="/" aria-label={t('brand.home')}>
      {/* A plain <img>: the export is static and next/image would need a loader. */}
      <img className="brand-logo" src="/assets/psu-logo.png" alt="" width={68} height={36} />
      <span className="brand-rule" aria-hidden="true" />
      <span className="brand-copy">
        <strong>PSU Data Hub</strong>
        <span>{t(tagline)}</span>
      </span>
    </Link>
  );
}
