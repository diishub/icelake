import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { FeedbackAlert, StatusBadge, usePublishFormat } from './shared';
import type { Alert, Release, ReleasePreview } from './shared';

interface Props {
  release: Release;
  preview: ReleasePreview | null;
  loading: boolean;
  alert: Alert | null;
  /** True while an approve/reject call is in flight. */
  deciding: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onAlert: (alert: Alert | null) => void;
  /** Bumped after a successful decision so the reject drawer closes. */
  decisionCount: number;
}

/** Release detail and decision. The decide buttons appear only when psu-auth says release.canDecide. */
export function DetailModal({
  release: r,
  preview,
  loading,
  alert,
  deciding,
  onClose,
  onApprove,
  onReject,
  onAlert,
  decisionCount,
}: Props) {
  const { t, tx } = useI18n();
  const { errorMessage, formatDate, formatNumber, releaseTitle, releaseDescription } = usePublishFormat();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setRejectOpen(false);
  }, [decisionCount]);

  useEffect(() => {
    if (rejectOpen) reasonRef.current?.focus();
  }, [rejectOpen]);

  const facts: [MessageKey, ReactNode][] = [
    ['review.colStatus', <StatusBadge release={r} />],
    ['review.colOrgUnit', r.ownerOrgUnit],
    ['publish.fieldAccess', tx(`publish.access.${r.accessLevel}`)],
    ['publish.fieldCadence', tx(`publish.cadence.${r.refreshCadence}`)],
    ['publish.fieldDomain', r.domain ? tx(`publish.domain.${r.domain}`) : t('publish.domainNone')],
    ['publish.fieldTags', r.tags && r.tags.length ? r.tags.join(', ') : '—'],
    ['publish.colRequester', `${r.requestedByName || '—'} · ${formatDate(r.requestedAt)}`],
  ];
  if (r.decidedAt) {
    facts.push(['review.reviewerLabel', `${r.decidedByName || '—'} · ${formatDate(r.decidedAt)}`]);
  }
  if (r.status === 'published') {
    facts.push(['publish.rowsPublished', formatNumber(r.rowCount)]);
    facts.push(['publish.publishedAt', formatDate(r.publishedAt)]);
    facts.push(['publish.snapshot', r.publishedSnapshotId || '—']);
  }
  if (r.status === 'rejected') {
    facts.push(['review.rejectionReasonLabel', r.rejectionReason || '—']);
  }
  if (r.status === 'failed') {
    facts.push(['publish.failureLabel', errorMessage(r.failureCode || 'copy_failed')]);
  }

  const description = releaseDescription(r);

  function confirmReject() {
    const trimmed = reason.trim();
    if (!trimmed) {
      onAlert({ message: errorMessage('reason_required'), kind: 'error' });
      return;
    }
    onReject(trimmed);
  }

  return (
    <div className="review-modal-backdrop">
      <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="detail-heading">
        <header className="review-modal-header">
          <div>
            <h2 className="review-modal-title" id="detail-heading">
              {releaseTitle(r)}
            </h2>
            <p className="review-modal-subtitle">
              {`polaris.curated.${r.tableName} → polaris.published.${r.tableName} · v${r.version}`}
            </p>
          </div>
          <button className="review-modal-close" type="button" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </header>

        <div className="review-modal-body">
          {loading ? (
            <p className="login-status" role="status" aria-live="polite">
              {t('review.loading')}
            </p>
          ) : null}
          <FeedbackAlert alert={alert} />

          <section className="modal-section modal-meta-section">
            <h3 className="modal-section-title">{t('review.sectionMeta')}</h3>
            <dl className="modal-meta-grid">
              {facts.map(([labelKey, value]) => (
                <div key={labelKey}>
                  <dt>{t(labelKey)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {description ? (
              <div className="modal-steward-note-box">
                <p className="modal-steward-note">{description}</p>
              </div>
            ) : null}
            {r.changelog ? (
              <div className="modal-steward-note-box">
                <strong>{t('publish.fieldChangelog')}</strong>
                <p className="modal-steward-note">{r.changelog}</p>
              </div>
            ) : null}
          </section>

          {preview && Array.isArray(preview.columns) ? (
            <section className="modal-section">
              <div className="section-title-flex">
                <h3 className="modal-section-title">{t('publish.sectionColumns')}</h3>
                <span className="summary-pill">{t('publish.rowCount', { count: formatNumber(preview.rowCount) })}</span>
              </div>
              <p className="input-hint-text">{t('publish.previewNoRows')}</p>
              <div className="columns-table-wrapper">
                <table className="columns-table">
                  <thead>
                    <tr>
                      <th>{t('review.columnColName')}</th>
                      <th>{t('review.columnType')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.columns.map((c) => (
                      <tr key={c.name}>
                        <td>
                          <code>{c.name}</code>
                        </td>
                        <td>{c.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>

        <footer className="review-modal-footer">
          <div className="footer-left">
            <button className="button button-ghost" type="button" onClick={onClose}>
              {t('review.btnClose')}
            </button>
          </div>
          {r.canDecide ? (
            <div className="footer-actions">
              <button className="button button-danger" type="button" disabled={deciding} onClick={() => setRejectOpen(true)}>
                {t('review.btnReject')}
              </button>
              <button className="button button-positive" type="button" disabled={deciding} onClick={onApprove}>
                {t('publish.btnApprove')}
              </button>
            </div>
          ) : null}
          {rejectOpen ? (
            <div className="modal-reject-drawer">
              <label htmlFor="release-reject-reason" className="reject-drawer-label">
                {t('review.rejectReasonPrompt')}
              </label>
              <textarea
                id="release-reject-reason"
                ref={reasonRef}
                rows={2}
                maxLength={1000}
                className="reject-reason-input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="reject-drawer-buttons">
                <button
                  className="button button-ghost button-small"
                  type="button"
                  disabled={deciding}
                  onClick={() => setRejectOpen(false)}
                >
                  {t('review.btnCancel')}
                </button>
                <button className="button button-danger button-small" type="button" disabled={deciding} onClick={confirmReject}>
                  {t('review.btnConfirmReject')}
                </button>
              </div>
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
