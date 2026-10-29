import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/i18n';
import { ColumnClassification, SampleGrid, TableConfig } from './CsvReview';
import { DecisionInfo } from './DecisionInfo';
import { DocumentText } from './DocumentText';
import { RejectDrawer } from './RejectDrawer';
import { StatusBadge } from './StatusBadge';
import { SQL_NAME, formatBytes, formatDate, isClassification, uploaderLabel } from './shared';
import type { ColumnState, ReviewPreview, ReviewUpload } from './shared';

interface Props {
  uploadId: string;
  onClose: () => void;
  /** Called after an approve / reject succeeds; resolves once the list is reloaded. */
  onDecided: () => Promise<void>;
}

interface PreviewResponse {
  upload: ReviewUpload;
  preview: ReviewPreview | null;
}

type Phase = 'loading' | 'ready' | 'error';

/** How often an open dialog re-reads an upload whose Iceberg load is running. */
const LOAD_POLL_MS = 3000;

/** Suggest a table suffix from the file name; psu-auth re-validates it anyway. */
function defaultSuffix(filename: string | undefined): string {
  const suffix = (filename || 'data')
    .replace(/\.csv$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!suffix || !/^[a-z]/.test(suffix)) {
    return `dataset_${Date.now().toString(36)}`;
  }
  return suffix;
}

/** The message psu-auth gave, or the HTTP status when it gave none. */
function errorDetail(error: unknown, preferDetail: boolean): string {
  if (error instanceof ApiError) {
    const detail = error.body?.detail;
    if (preferDetail && typeof detail === 'string' && detail) return detail;
    return error.code.startsWith('http_') ? `HTTP ${error.status}` : error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Review dialog for one staged upload: metadata, then either the decision that
 * was taken or the tools to take one (CSV: target table + column
 * classification; PDF/DOCX: extracted text).
 */
export function ReviewModal({ uploadId, onClose, onDecided }: Props) {
  const { t, language } = useI18n();
  const [reloadToken, setReloadToken] = useState(0);
  const [phase, setPhase] = useState<Phase>('loading');
  const [upload, setUpload] = useState<ReviewUpload | null>(null);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [suffix, setSuffix] = useState('');
  const [columns, setColumns] = useState<ColumnState[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reason, setReason] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    closeButton.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setAlert(null);
    setBusy(null);
    setDrawerOpen(false);
    api<PreviewResponse>('GET', `/auth/reviews/${encodeURIComponent(uploadId)}/preview`)
      .then((data) => {
        if (cancelled) return;
        setUpload(data.upload);
        setPreview(data.preview);
        if (data.upload.status === 'pending_review' && data.upload.fileKind === 'csv') {
          setSuffix(defaultSuffix(data.upload.originalFilename));
          setColumns(
            (data.preview?.columns ?? []).map((c) => ({
              raw: c.name,
              name: c.name,
              originalName: c.originalName || c.name,
              type: c.type || 'VARCHAR',
              classification: isClassification(c.classification) ? c.classification : 'public',
            })),
          );
        }
        setPhase('ready');
      })
      .catch(() => {
        // Generic message only: the response may name internals.
        if (!cancelled) setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [uploadId, reloadToken]);

  // Escape closes the reject drawer first, then the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (drawerOpen) {
        setDrawerOpen(false);
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, onClose]);

  // Close on a click on the backdrop itself, but not when a text selection that
  // started inside the dialog ends outside it.
  const onBackdropDown = (event: MouseEvent<HTMLDivElement>) => {
    pressStartedOnBackdrop.current = event.target === event.currentTarget;
  };
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (pressStartedOnBackdrop.current && event.target === event.currentTarget) onClose();
    pressStartedOnBackdrop.current = false;
  };

  const ready = phase === 'ready' && upload !== null;
  const isCsv = upload?.fileKind === 'csv';
  const isPending = ready && upload.status === 'pending_review';
  const isLoading = ready && upload.status === 'loading';
  const publicCount = columns.filter((c) => c.classification === 'public').length;

  const afterDecision = async () => {
    await onDecided();
    // Re-open as decided, as the old portal did, unless the reviewer closed the dialog meanwhile.
    if (alive.current) setReloadToken((n) => n + 1);
  };

  // Approving a CSV answers before the load finishes (psu-auth runCsvLoad);
  // re-read the upload until it lands as registered or returns to pending.
  useEffect(() => {
    if (!isLoading) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api<PreviewResponse>('GET', `/auth/reviews/${encodeURIComponent(uploadId)}/preview`)
        .then((data) => {
          if (cancelled || data.upload.status === 'loading') return;
          cancelled = true;
          window.clearInterval(timer);
          void afterDecision();
        })
        .catch(() => {
          // Keep polling; a single failed read is not an outcome.
        });
    }, LOAD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // afterDecision only closes over props and setters that do not change while open.
  }, [isLoading, uploadId]);

  const handleApprove = async () => {
    if (!upload) return;
    setAlert(null);

    let payload: Record<string, unknown> = {};
    if (upload.fileKind === 'csv') {
      const tableSuffix = suffix.trim().toLowerCase();
      if (!tableSuffix || !SQL_NAME.test(tableSuffix)) {
        setAlert(`${t('review.errorApprove')} ${t('review.errorTableSuffix')}`);
        return;
      }
      for (const col of columns) {
        if (!SQL_NAME.test(col.name)) {
          setAlert(`${t('review.errorApprove')} ${t('review.errorColumnName', { name: col.name })}`);
          return;
        }
      }
      payload = {
        tableSuffix,
        columns: columns.map((c) => ({ name: c.name, type: c.type, classification: c.classification })),
      };
    }

    setBusy('approve');
    try {
      await api('POST', `/auth/reviews/${encodeURIComponent(upload.uploadId)}/approve`, payload);
    } catch (error) {
      if (!alive.current) return;
      setAlert(`${t('review.errorApprove')} ${errorDetail(error, true)}`);
      setBusy(null);
      return;
    }
    await afterDecision();
  };

  const handleConfirmReject = async () => {
    if (!upload) return;
    setBusy('reject');
    try {
      await api('POST', `/auth/reviews/${encodeURIComponent(upload.uploadId)}/reject`, { reason: reason.trim() });
    } catch (error) {
      if (!alive.current) return;
      setAlert(`${t('review.errorReject')} ${errorDetail(error, false)}`);
      setBusy(null);
      return;
    }
    setDrawerOpen(false);
    await afterDecision();
  };

  const openDrawer = () => {
    setReason('');
    setDrawerOpen(true);
  };

  const updateColumn = (index: number, patch: Partial<ColumnState>) => {
    setColumns((current) => current.map((col, i) => (i === index ? { ...col, ...patch } : col)));
  };

  const dash = '—';

  return (
    <div className="review-modal-backdrop" onMouseDown={onBackdropDown} onClick={onBackdropClick}>
      <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="modal-heading">
        <header className="review-modal-header">
          <div>
            <h2 className="review-modal-title" id="modal-heading">
              {t('review.modalTitle')}
            </h2>
            <p className="review-modal-subtitle">
              {ready ? `${upload.originalFilename} (${formatBytes(upload.sizeBytes)})` : dash}
            </p>
          </div>
          <button
            ref={closeButton}
            className="review-modal-close"
            type="button"
            aria-label={t('review.btnClose')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="review-modal-body">
          {phase !== 'ready' ? (
            <p className="login-status" role="status" aria-live="polite">
              {t(phase === 'loading' ? 'review.loading' : 'login.serviceUnavailable')}
            </p>
          ) : null}
          {alert ? (
            <div className="modal-feedback-alert" role="alert">
              {alert}
            </div>
          ) : null}
          {isPending && upload.loadError ? (
            <div className="modal-feedback-alert" role="alert">
              {t('review.loadFailed', { code: upload.loadError })}
            </div>
          ) : null}
          {isLoading ? (
            <p className="login-status" role="status" aria-live="polite">
              {t('review.loadingNotice')}
            </p>
          ) : null}

          <section className="modal-section modal-meta-section">
            <h3 className="modal-section-title">{t('review.sectionMeta')}</h3>
            <dl className="modal-meta-grid">
              <div>
                <dt>{t('review.colOrgUnit')}</dt>
                <dd>{ready ? upload.orgUnit : dash}</dd>
              </div>
              <div>
                <dt>{t('review.colUploader')}</dt>
                <dd>{ready ? uploaderLabel(upload) : dash}</dd>
              </div>
              <div>
                <dt>{t('review.metaFileSize')}</dt>
                <dd>{ready ? formatBytes(upload.sizeBytes) : dash}</dd>
              </div>
              <div>
                <dt>{t('review.colUploadedAt')}</dt>
                <dd>{ready ? formatDate(upload.uploadedAt, language) : dash}</dd>
              </div>
              <div>
                <dt>{t('review.colStatus')}</dt>
                <dd>{ready ? <StatusBadge status={upload.status} /> : dash}</dd>
              </div>
              <div>
                <dt>{t('review.metaUploadId')}</dt>
                <dd>
                  <code>{ready ? upload.uploadId : dash}</code>
                </dd>
              </div>
            </dl>
            {ready && upload.uploaderNote ? (
              <div className="modal-steward-note-box">
                <strong>{t('review.stewardNoteLabel')}</strong>
                <p className="modal-steward-note">{upload.uploaderNote}</p>
              </div>
            ) : null}
          </section>

          {ready && (upload.status === 'registered' || upload.status === 'rejected') ? (
            <DecisionInfo upload={upload} />
          ) : null}

          {isPending && isCsv ? (
            <>
              <TableConfig orgUnit={upload.orgUnit} suffix={suffix} onSuffix={setSuffix} />
              <ColumnClassification columns={columns} sampleRows={preview?.sampleRows ?? []} onChange={updateColumn} />
              <SampleGrid preview={preview} />
            </>
          ) : null}

          {isPending && !isCsv ? <DocumentText preview={preview} /> : null}
        </div>

        <footer className="review-modal-footer">
          <div className="footer-left">
            <button className="button button-ghost" type="button" onClick={onClose}>
              {t('review.btnClose')}
            </button>
          </div>
          {isPending ? (
            <div className="footer-actions">
              <button
                className="button button-danger"
                type="button"
                disabled={busy === 'approve'}
                onClick={openDrawer}
              >
                {t('review.btnReject')}
              </button>
              <button
                className="button button-positive"
                type="button"
                disabled={busy !== null || (isCsv && publicCount === 0)}
                onClick={() => void handleApprove()}
              >
                {t(busy === 'approve' ? 'review.btnApproving' : isCsv ? 'review.btnApprove' : 'review.btnApproveDoc')}
              </button>
            </div>
          ) : null}
          {drawerOpen ? (
            <RejectDrawer
              reason={reason}
              onReason={setReason}
              busy={busy === 'reject'}
              onCancel={() => setDrawerOpen(false)}
              onConfirm={() => void handleConfirmReject()}
            />
          ) : null}
        </footer>
      </div>
    </div>
  );
}
