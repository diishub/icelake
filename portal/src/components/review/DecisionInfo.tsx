import { useI18n } from '@/i18n';
import { CopyButton } from './CopyButton';
import { formatDate } from './shared';
import type { ReviewUpload } from './shared';

/** Outcome card for an upload that has already been approved or rejected. */
export function DecisionInfo({ upload }: { upload: ReviewUpload }) {
  const { t, language } = useI18n();
  const reviewer = upload.reviewedByUsername || '—';
  const reviewedAt = formatDate(upload.reviewedAt, language);

  if (upload.status === 'registered') {
    // Documents are approved without a table, so there is nothing to query.
    const fullTable = upload.targetTable ? `polaris.raw."${upload.targetTable}"` : null;
    const sql = fullTable ? `SELECT * FROM ${fullTable} LIMIT 10;` : '';
    return (
      <section className="modal-section modal-decision-section">
        <div className="decision-card-registered">
          <h4 className="decision-heading">{t('review.approvedNotice')}</h4>
          <p className="decision-detail">
            <span>{t('review.reviewerLabel')}</span> <strong>{reviewer}</strong> |{' '}
            <span>{t('review.reviewedAtLabel')}</span> <span>{reviewedAt}</span>
          </p>
          <div className="decision-table-info">
            <span>{t('review.tablePrefixLabel')}</span> <code>{fullTable ?? t('upload.documentApproved')}</code>
          </div>
          <p className="decision-columns-count">
            {fullTable
              ? `${t('review.summaryIncluded')} ${upload.columnsIncluded ?? 0} | ${t('review.summaryExcluded')} ${upload.columnsExcluded ?? 0}`
              : ''}
          </p>
          {fullTable ? (
            <div className="decision-sql-box">
              <label htmlFor="decision-sql-snippet">{t('review.trinoQueryExample')}</label>
              <div className="code-copy-row">
                <pre>
                  <code id="decision-sql-snippet">{sql}</code>
                </pre>
                <CopyButton text={sql} />
              </div>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="modal-section modal-decision-section">
      <div className="decision-card-rejected">
        <h4 className="decision-heading">{t('review.rejectedNotice')}</h4>
        <p className="decision-detail">
          <span>{t('review.reviewerLabel')}</span> <strong>{reviewer}</strong> |{' '}
          <span>{t('review.reviewedAtLabel')}</span> <span>{reviewedAt}</span>
        </p>
        {upload.rejectionReason ? (
          <p className="decision-reason-row">
            <span>{t('review.rejectionReasonLabel')}</span>{' '}
            <strong className="decision-rejection-text">{upload.rejectionReason}</strong>
          </p>
        ) : null}
      </div>
    </section>
  );
}
