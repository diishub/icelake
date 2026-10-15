import { useI18n } from '@/i18n';
import { CopyButton } from './CopyButton';
import type { ReviewPreview } from './shared';

/** Text psu-auth extracted from a pending PDF / DOCX upload. */
export function DocumentText({ preview }: { preview: ReviewPreview | null }) {
  const { t } = useI18n();
  const text = preview?.hasExtractedText && preview.extractedText ? preview.extractedText : '';

  return (
    <section className="modal-section">
      <div className="section-title-flex">
        <h3 className="modal-section-title">{t('review.sectionExtractedText')}</h3>
        <CopyButton text={text} />
      </div>
      <div className="document-text-container">
        {text ? (
          <pre className="document-text-content">{text}</pre>
        ) : (
          <p className="document-no-text">{t('review.noExtractedText')}</p>
        )}
      </div>
    </section>
  );
}
