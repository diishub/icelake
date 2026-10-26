/*
 * Analyst review and approval interface.
 * Allows analysts, developers and admins to review staged uploads, classify CSV columns,
 * inspect document text, and bridge approved datasets into Iceberg.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RequireTier } from '@/components/RequireTier';
import { WorkspaceLayout } from '@/components/WorkspaceLayout';
import { ReviewList } from '@/components/review/ReviewList';
import type { ListState, ReviewFilter } from '@/components/review/ReviewList';
import { ReviewModal } from '@/components/review/ReviewModal';
import type { ReviewUpload } from '@/components/review/shared';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';

function ReviewWorkspace() {
  const { t } = useI18n();
  const [uploads, setUploads] = useState<ReviewUpload[]>([]);
  const [listState, setListState] = useState<ListState>('loading');
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  // Where focus goes back to when the dialog closes.
  const trigger = useRef<HTMLElement | null>(null);

  const loadUploads = useCallback(async () => {
    setListState('loading');
    try {
      const data = await api<{ uploads?: unknown }>('GET', '/auth/reviews');
      setUploads(Array.isArray(data.uploads) ? (data.uploads as ReviewUpload[]) : []);
      setListState('ready');
    } catch {
      // Generic message only; nothing about the uploads is logged.
      setListState('error');
    }
  }, []);

  useEffect(() => {
    void loadUploads();
  }, [loadUploads]);

  const openReview = (upload: ReviewUpload, from: HTMLElement) => {
    trigger.current = from;
    setOpenId(upload.uploadId);
  };

  const closeReview = useCallback(() => {
    setOpenId(null);
    // The row button may have been re-rendered by a reload; only refocus it if it is still there.
    const from = trigger.current;
    trigger.current = null;
    if (from && from.isConnected) from.focus();
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="breadcrumb">
            <span>{t('ws.breadcrumb')}</span> / <span>{t('ws.review')}</span>
          </p>
          <h1 className="page-title">{t('review.heading')}</h1>
          <p className="page-lead">{t('review.subheading')}</p>
        </div>
        <div className="page-actions">
          <button className="button button-ghost" type="button" onClick={() => void loadUploads()}>
            {t('review.refresh')}
          </button>
        </div>
      </div>

      <ReviewList uploads={uploads} state={listState} filter={filter} onFilter={setFilter} onOpen={openReview} />

      {openId ? <ReviewModal key={openId} uploadId={openId} onClose={closeReview} onDecided={loadUploads} /> : null}
    </>
  );
}

export default function ReviewPage() {
  return (
    <WorkspaceLayout page="review" title="ws.review" description="review.subheading" mainId="review-main">
      <RequireTier page="review" forbidden="review.forbidden" checking="review.checking">
        {() => <ReviewWorkspace />}
      </RequireTier>
    </WorkspaceLayout>
  );
}
