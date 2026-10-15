import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { formatBytes, formatDate, uploaderLabel } from './shared';
import type { ReviewUpload } from './shared';
import { StatusBadge } from './StatusBadge';

export type ReviewFilter = 'pending' | 'all' | 'registered' | 'rejected';
export type ListState = 'loading' | 'ready' | 'error';

const FILTER_STATUS: Record<ReviewFilter, string | null> = {
  pending: 'pending_review',
  all: null,
  registered: 'registered',
  rejected: 'rejected',
};

const TABS: { filter: ReviewFilter; label: MessageKey }[] = [
  { filter: 'pending', label: 'review.tabPending' },
  { filter: 'all', label: 'review.tabAll' },
  { filter: 'registered', label: 'review.tabRegistered' },
  { filter: 'rejected', label: 'review.tabRejected' },
];

interface Props {
  uploads: ReviewUpload[];
  state: ListState;
  filter: ReviewFilter;
  onFilter: (filter: ReviewFilter) => void;
  onOpen: (upload: ReviewUpload, trigger: HTMLElement) => void;
}

/** Stat cards, filter tabs and the uploads table. */
export function ReviewList({ uploads, state, filter, onFilter, onOpen }: Props) {
  const { t, language } = useI18n();

  const count = (status: string) => uploads.filter((u) => u.status === status).length;
  const pending = count('pending_review');
  const wanted = FILTER_STATUS[filter];
  const filtered = wanted ? uploads.filter((u) => u.status === wanted) : uploads;

  let list;
  if (state === 'loading') {
    list = <p className="review-empty-state">{t('review.loading')}</p>;
  } else if (state === 'error') {
    list = <p className="review-empty-state text-critical">{t('login.serviceUnavailable')}</p>;
  } else if (filtered.length === 0) {
    list = <p className="review-empty-state">{t('review.emptyList')}</p>;
  } else {
    list = (
      <table className="review-table">
        <thead>
          <tr>
            <th>{t('review.colFilename')}</th>
            <th>{t('review.colOrgUnit')}</th>
            <th>{t('review.colUploader')}</th>
            <th>{t('review.colUploadedAt')}</th>
            <th>{t('review.colStatus')}</th>
            <th>{t('review.colAction')}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((item) => {
            const isPending = item.status === 'pending_review';
            return (
              <tr className="review-table-row" key={item.uploadId}>
                <td>
                  <div className="file-name-cell">
                    <span className={`upload-kind-badge upload-kind-${item.fileKind}`}>
                      {(item.fileKind || 'csv').toUpperCase()}
                    </span>
                    <div className="file-name-info">
                      <strong className="upload-filename">{item.originalFilename}</strong>
                      <small className="upload-size">{formatBytes(item.sizeBytes)}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <code>{item.orgUnit}</code>
                </td>
                <td>{uploaderLabel(item)}</td>
                <td>{formatDate(item.uploadedAt, language)}</td>
                <td>
                  <StatusBadge status={item.status} />
                </td>
                <td>
                  <button
                    className={`button ${isPending ? 'button-primary' : 'button-ghost'} button-small`}
                    type="button"
                    onClick={(event) => onOpen(item, event.currentTarget)}
                  >
                    {t(isPending ? 'review.btnReview' : 'review.btnView')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <>
      <div className="review-stats-grid">
        <div className="review-stat-card">
          <span className="review-stat-label">{t('review.tabPending')}</span>
          <strong className="review-stat-value text-caution">{pending}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('review.tabRegistered')}</span>
          <strong className="review-stat-value text-positive">{count('registered')}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('review.tabRejected')}</span>
          <strong className="review-stat-value text-critical">{count('rejected')}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('review.tabAll')}</span>
          <strong className="review-stat-value">{uploads.length}</strong>
        </div>
      </div>

      <div className="review-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.filter}
            className={`review-tab${filter === tab.filter ? ' is-active' : ''}`}
            type="button"
            role="tab"
            id={`tab-${tab.filter}`}
            aria-selected={filter === tab.filter}
            onClick={() => onFilter(tab.filter)}
          >
            {tab.filter === 'pending' ? (
              <>
                <span>{t(tab.label)}</span> <span className="review-badge-counter">{pending}</span>
              </>
            ) : (
              t(tab.label)
            )}
          </button>
        ))}
      </div>

      <div className="review-table-wrapper" role="region" aria-live="polite">
        <div className="review-list-container">{list}</div>
      </div>
    </>
  );
}
