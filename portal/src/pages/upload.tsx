/*
 * Steward-only upload page. Gated client-side for UX (redirect/message when
 * signed out or wrong tier); the real gate is server-side in
 * services/auth/src/server.ts's /auth/uploads, which checks the session and
 * accessTier itself and never trusts anything this page decides.
 */
import { useCallback, useEffect, useState } from 'react';
import { RequireTier } from '@/components/RequireTier';
import { WorkspaceLayout } from '@/components/WorkspaceLayout';
import { UploadForm } from '@/components/upload/UploadForm';
import { UploadHistory } from '@/components/upload/UploadHistory';
import type { UploadItem } from '@/components/upload/types';
import { useI18n } from '@/i18n';
import type { PortalUser } from '@/lib/auth';

function UploadWorkspace({ user }: { user: PortalUser }) {
  const { t } = useI18n();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchUploadHistory = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/auth/uploads', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      // A failed refresh keeps the list already shown.
      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as { uploads?: unknown };
        setUploads(Array.isArray(data.uploads) ? (data.uploads as UploadItem[]) : []);
      }
    } catch (error) {
      console.error('[upload] fetch history failed', error);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchUploadHistory();
  }, [fetchUploadHistory]);

  let pending = 0;
  let registered = 0;
  let rejected = 0;
  for (const item of uploads) {
    if (item.status === 'pending_review') pending++;
    else if (item.status === 'registered') registered++;
    else if (item.status === 'rejected') rejected++;
  }

  return (
    <div id="upload-form-area">
      <div className="page-head">
        <div>
          <p className="breadcrumb">
            <span>{t('ws.breadcrumb')}</span> / <span>{t('ws.upload')}</span>
          </p>
          <h1 className="page-title">{t('upload.heading')}</h1>
          <p className="page-lead">{t('upload.subheading')}</p>
        </div>
      </div>

      <div className="review-stats-grid">
        <div className="review-stat-card">
          <span className="review-stat-label">{t('upload.statPending')}</span>
          <strong className="review-stat-value text-caution" id="steward-stat-pending">{pending}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('upload.statRegistered')}</span>
          <strong className="review-stat-value text-positive" id="steward-stat-registered">{registered}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('upload.statRejected')}</span>
          <strong className="review-stat-value text-critical" id="steward-stat-rejected">{rejected}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('upload.statTotal')}</span>
          <strong className="review-stat-value" id="steward-stat-total">{uploads.length}</strong>
        </div>
      </div>

      <div className="upload-layout">
        <UploadForm orgUnit={user.orgUnit} onUploaded={() => void fetchUploadHistory()} />
        <UploadHistory uploads={uploads} refreshing={refreshing} onRefresh={() => void fetchUploadHistory()} />
      </div>
    </div>
  );
}

export default function UploadPage() {
  return (
    <WorkspaceLayout page="upload" title="ws.upload" description="upload.subheading" mainId="upload-main">
      <RequireTier page="upload" forbidden="upload.forbidden" checking="upload.checking">
        {(user) => <UploadWorkspace user={user} />}
      </RequireTier>
    </WorkspaceLayout>
  );
}
