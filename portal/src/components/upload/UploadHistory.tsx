import { useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { formatBytes } from './types';
import type { UploadItem } from './types';

type Filter = 'all' | UploadItem['status'];

const FILTERS: { value: Filter; label: MessageKey }[] = [
  { value: 'all', label: 'upload.filterAll' },
  { value: 'pending_review', label: 'upload.filterPending' },
  { value: 'registered', label: 'upload.filterRegistered' },
  { value: 'rejected', label: 'upload.filterRejected' },
];

interface Props {
  uploads: UploadItem[];
  refreshing: boolean;
  onRefresh: () => void;
}

/** The steward's own submissions with their review status, filterable by status and text. */
export function UploadHistory({ uploads, refreshing, onRefresh }: Props) {
  const { t, language } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  function formatDate(isoString: string): string {
    if (!isoString) {
      return '—';
    }
    try {
      return new Date(isoString).toLocaleString(language === 'th' ? 'th-TH' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  }

  let filtered = filter === 'all' ? uploads : uploads.filter((u) => u.status === filter);
  const q = search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((u) =>
      [u.originalFilename, u.uploaderNote, u.rejectionReason, u.targetTable].some((field) =>
        (field || '').toLowerCase().includes(q)));
  }

  let body: ReactNode;
  if (uploads.length === 0) {
    body = (
      <div className="upload-history-empty-state">
        <p className="upload-history-empty">{t('upload.emptyHistory')}</p>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <div className="upload-history-empty-state">
        <p className="upload-history-empty">{t('upload.noMatch')}</p>
      </div>
    );
  } else {
    body = filtered.map((item) => {
      const kind = (item.fileKind || 'csv').toUpperCase();
      let statusClass = 'status-badge-pending';
      let statusText = t('upload.statusPending');
      let statusDetail: ReactNode = t('upload.pendingDetail');

      if (item.status === 'registered') {
        statusClass = 'status-badge-registered';
        statusText = t('upload.statusRegistered');
        statusDetail = item.targetTable ? (
          <>
            {t('upload.targetTablePrefix')} <code className="target-table-code">polaris.raw.{item.targetTable}</code>
          </>
        ) : (
          t('upload.documentApproved')
        );
      } else if (item.status === 'rejected') {
        statusClass = 'status-badge-rejected';
        statusText = t('upload.statusRejected');
        statusDetail = item.reviewedByUsername ? t('upload.reviewedBy', { name: item.reviewedByUsername }) : '';
      }

      return (
        <article className="upload-item upload-item-card" key={item.uploadId}>
          <div className="upload-item-main">
            <div className="upload-item-file">
              <span className={`upload-kind-badge upload-kind-${kind.toLowerCase()}`}>{kind}</span>
              <strong className="upload-filename" title={item.originalFilename}>
                {item.originalFilename}
              </strong>
            </div>
            <div className="upload-item-meta">
              <span className="file-size-tag">{formatBytes(item.sizeBytes)}</span>
              <span className="meta-dot" aria-hidden="true">
                ·
              </span>
              <time dateTime={item.uploadedAt} className="upload-time">
                {formatDate(item.uploadedAt)}
              </time>
            </div>
            {item.uploaderNote ? (
              <div className="upload-note-box">
                <div className="note-body">
                  <span className="upload-note-label">{t('upload.yourNoteLabel')}:</span>{' '}
                  <span className="upload-note-text">{item.uploaderNote}</span>
                </div>
              </div>
            ) : null}
            {item.status === 'rejected' ? (
              <div className="upload-rejection-box" role="alert">
                <div className="rejection-body">
                  <span className="upload-rejection-label">{t('upload.rejectionReasonLabel')}:</span>{' '}
                  <span className="upload-rejection-text">{item.rejectionReason || t('upload.noReasonProvided')}</span>
                </div>
              </div>
            ) : null}
          </div>
          <div className="upload-item-status">
            <span className={`upload-status-badge ${statusClass}`}>{statusText}</span>
            {statusDetail ? <div className="upload-status-detail">{statusDetail}</div> : null}
          </div>
        </article>
      );
    });
  }

  return (
    <section className="panel upload-history-panel" aria-labelledby="upload-history-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="upload-history-title">
            {t('upload.historyHeading')}
          </h2>
          <p className="panel-desc">{t('upload.historySubheading')}</p>
        </div>
        <button
          className={`button button-ghost button-small upload-refresh-btn${refreshing ? ' is-spinning' : ''}`}
          type="button"
          id="upload-refresh-btn"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {t('upload.refresh')}
        </button>
      </div>
      <div className="review-tabs" role="tablist" id="tracker-tabs">
        {FILTERS.map((entry) => (
          <button
            key={entry.value}
            className={`review-tab tracker-tab${filter === entry.value ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={filter === entry.value}
            onClick={() => setFilter(entry.value)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      <div className="tracker-search-wrap">
        <label className="sr-only" htmlFor="upload-search-input">
          {t('upload.searchLabel')}
        </label>
        <input
          type="search"
          id="upload-search-input"
          className="input"
          placeholder={t('upload.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div id="upload-history-list" className="upload-history-container" role="region" aria-live="polite">
        {body}
      </div>
    </section>
  );
}
